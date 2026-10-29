'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const { CatalogError, createCatalogLoader } = require('./lib/catalog');
const {
  CheckoutError,
  buildOrder,
  collectPii,
  scrubValues,
  validateBuyer,
  validateDelivery,
} = require('./lib/pricing');
const { MpError, buildPreference, createMpClient, publicUrlInfo, verifyWebhookSignature } = require('./lib/mp');
const { createOrderStore } = require('./lib/orders');
const { createRateLimiter } = require('./lib/ratelimit');

const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5502,http://127.0.0.1:5502';
const IMAGE_EXTENSIONS = /\.(webp|jpe?g|png|gif|avif|svg)$/i;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

const consoleLogger = Object.fromEntries(
  ['info', 'warn', 'error'].map((level) => [
    level,
    (msg, fields = {}) => console[level === 'info' ? 'log' : level](JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })),
  ]),
);

function errorBody(code, message) {
  return { error: message, code };
}

function normalizePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('PUBLIC_URL debe ser http(s)');
  return url.origin;
}

function parseTrustProxy(value) {
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// Defensa en profundidad: ningun log puede llevar el token ni el secret del webhook,
// ni siquiera si un mensaje de error de terceros los repitiera.
function redactingLogger(logger, secrets) {
  const scrub = (value) => (typeof value === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value) : value);
  return Object.fromEntries(
    ['info', 'warn', 'error'].map((level) => [
      level,
      (msg, fields = {}) => logger[level](msg, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, scrub(value)]))),
    ]),
  );
}

function createApp({
  fetch = globalThis.fetch,
  env = process.env,
  rootDir = path.resolve(__dirname, '..'),
  catalogPath = path.join(rootDir, 'catalog.json'),
  dataDir = path.join(__dirname, 'data'),
  logger: baseLogger = consoleLogger,
  now = Date.now,
  retryDelayMs = 300,
} = {}) {
  const port = Number(env.PORT) || 3000;
  const publicUrl = normalizePublicUrl(env.PUBLIC_URL || `http://localhost:${port}`);
  const { isHttps, isLocal } = publicUrlInfo(publicUrl);
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .concat(publicUrl),
  );
  const accessToken = (env.MP_ACCESS_TOKEN || '').trim();
  const webhookSecret = (env.MP_WEBHOOK_SECRET || '').trim();
  const logger = redactingLogger(baseLogger, [accessToken, webhookSecret].filter(Boolean));

  const getCatalog = createCatalogLoader(catalogPath, logger);
  const orders = createOrderStore(dataDir);
  const mp = accessToken ? createMpClient({ fetch, accessToken, retryDelayMs }) : null;
  const checkoutLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, now });
  const webhookLimiter = createRateLimiter({ limit: 300, windowMs: 60_000, now });

  if (!mp) logger.warn('mp.sin_token', { detail: 'MP_ACCESS_TOKEN no está configurado: /api/checkout responde 503' });
  if (isLocal) logger.warn('mp.public_url_local', { publicUrl, detail: 'sin webhook ni auto_return; para probar el flujo completo usá una URL https (ngrok)' });
  if (!webhookSecret) logger.warn('mp.sin_webhook_secret', { detail: 'MP_WEBHOOK_SECRET no está configurado: el webhook no verifica la firma' });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

  // --- Cabeceras comunes, request id y CORS ---------------------------------
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

    const origin = req.get('origin');
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS' && req.path.startsWith('/api/')) return res.status(204).end();
    return next();
  });

  const limit = (limiter, name) => (req, res, next) => {
    const result = limiter.check(req.ip);
    if (result.ok) return next();
    logger.warn('rate_limit', { route: name, requestId: req.id });
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json(errorBody('demasiadas_solicitudes', 'Demasiados intentos. Esperá un minuto y probá de nuevo.'));
  };

  const requireJson = (req, res, next) => {
    if (JSON_CONTENT_TYPE.test(req.get('content-type') || '')) return next();
    return res.status(415).json(errorBody('content_type_invalido', 'Content-Type debe ser application/json.'));
  };
  const jsonBody = express.json({ limit: '50kb', strict: true });

  // --- API --------------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, mpConfigured: Boolean(mp) });
  });

  app.post('/api/checkout', limit(checkoutLimiter, 'checkout'), requireJson, jsonBody, async (req, res) => {
    const { items, buyer: rawBuyer, delivery: rawDelivery } = req.body ?? {};
    const catalog = getCatalog();
    const order = buildOrder(catalog, items);
    const buyer = validateBuyer(rawBuyer);
    const delivery = validateDelivery(rawDelivery);

    if (!mp) {
      return res.status(503).json({
        error: 'pagos_no_configurados',
        code: 'pagos_no_configurados',
        message: 'El pago online todavía no está habilitado.',
      });
    }

    const orderId = crypto.randomUUID();
    const preference = buildPreference({
      order,
      orderId,
      buyer,
      delivery,
      publicUrl,
      installments: catalog.store.installments,
    });

    let created;
    try {
      created = await mp.createPreference(preference, orderId);
    } catch (err) {
      // El mensaje de Mercado Pago es texto de un tercero: puede repetir datos del comprador.
      const mpMessage = scrubValues(err.mpMessage ?? null, collectPii(buyer, delivery));
      logger.error('checkout.mp_failed', { requestId: req.id, orderId, status: err.status ?? null, mpMessage, reason: err.message });
      return res.status(502).json(errorBody('mp_error', 'No pudimos iniciar el pago. Probá de nuevo en unos minutos.'));
    }

    // El registro solo sirve para reconstruir el pedido y cotejar el monto en el webhook:
    // si falla el disco no se frena la venta.
    try {
      await orders.savePending({
        orderId,
        preferenceId: created.id,
        total: order.total,
        currency: order.currency,
        lines: order.lines.map(({ id, name, qty, size, color, unitPrice }) => ({ id, name, qty, size, color, unitPrice })),
        buyer,
        delivery,
        createdAt: new Date(now()).toISOString(),
      });
    } catch (err) {
      logger.error('checkout.pending_not_saved', { requestId: req.id, orderId, reason: err.message });
    }

    logger.info('checkout.created', { requestId: req.id, orderId, lines: order.lines.length, total: order.total });
    return res.json({ init_point: created.initPoint, orderId });
  });

  app.post('/api/webhook', limit(webhookLimiter, 'webhook'), jsonBody, async (req, res) => {
    const url = new URL(req.originalUrl, 'http://localhost');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const queryDataId = url.searchParams.get('data.id');

    if (webhookSecret) {
      const valid = verifyWebhookSignature({
        secret: webhookSecret,
        signatureHeader: req.get('x-signature'),
        requestId: req.get('x-request-id'),
        dataId: queryDataId,
      });
      if (!valid) {
        logger.warn('webhook.firma_invalida', { requestId: req.id });
        return res.status(401).json(errorBody('firma_invalida', 'Firma inválida.'));
      }
    } else {
      logger.warn('webhook.sin_verificar', { requestId: req.id });
    }

    const type = String(url.searchParams.get('type') ?? body.type ?? '');
    if (type !== 'payment') return res.json({ ok: true, ignored: 'tipo_no_soportado' });

    const paymentId = String(queryDataId ?? body.data?.id ?? '');
    if (!/^\d{1,20}$/.test(paymentId)) {
      return res.status(400).json(errorBody('payment_id_invalido', 'data.id inválido.'));
    }
    if (!mp) return res.status(503).json({ error: 'pagos_no_configurados', code: 'pagos_no_configurados' });

    // El payload no es de fiar: el estado real se consulta a Mercado Pago.
    let payment;
    try {
      payment = await mp.getPayment(paymentId);
    } catch (err) {
      logger.error('webhook.mp_failed', { requestId: req.id, paymentId, status: err.status ?? null, reason: err.message });
      return res.status(502).json(errorBody('mp_error', 'No se pudo verificar el pago.'));
    }
    if (!payment) return res.json({ ok: true, ignored: 'pago_inexistente' });
    if (payment.status !== 'approved') return res.json({ ok: true, status: String(payment.status) });

    const orderId = typeof payment.external_reference === 'string' && payment.external_reference.length <= 64
      ? payment.external_reference
      : null;
    const pending = orderId ? await orders.findPending(orderId) : null;
    const amount = Number(payment.transaction_amount);
    const amountMatches = pending ? Math.abs(pending.total - amount) < 0.01 : null;
    const fallbackItems = Array.isArray(payment.additional_info?.items)
      ? payment.additional_info.items.map((item) => ({
        id: item.id ?? null,
        name: item.title ?? null,
        qty: Number(item.quantity),
        unitPrice: Number(item.unit_price),
      }))
      : [];

    const { recorded } = await orders.recordApproved({
      orderId,
      paymentId,
      status: 'approved',
      amount,
      currency: payment.currency_id ?? pending?.currency ?? null,
      amountMatches,
      items: pending?.lines ?? fallbackItems,
      buyer: pending?.buyer ?? (payment.payer?.email ? { email: payment.payer.email } : {}),
      delivery: pending?.delivery ?? null,
      recordedAt: new Date(now()).toISOString(),
    });
    if (amountMatches === false) {
      logger.warn('webhook.monto_distinto', { requestId: req.id, orderId, paymentId, expected: pending.total, received: amount });
    }
    logger.info('webhook.pago_aprobado', { requestId: req.id, orderId, paymentId, recorded });
    return res.json({ ok: true, recorded });
  });

  app.use('/api', (req, res) => {
    res.status(404).json(errorBody('no_encontrado', 'Ruta inexistente.'));
  });

  // --- Sitio estatico: WHITELIST explicita (nunca express.static sobre la raiz) ---
  // La raiz del repo tiene server/.env, los PDF del cliente y la carpeta bench/.
  // Si el front agrega otro archivo publico en la raiz, se suma a PUBLIC_FILES.
  const PUBLIC_FILES = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/catalog.json', 'catalog.json'],
  ]);

  app.get([...PUBLIC_FILES.keys()], (req, res) => {
    const file = path.join(rootDir, PUBLIC_FILES.get(req.path));
    res.sendFile(file, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache' } }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode === 404 ? 404 : 500).end();
    });
  });

  app.use(
    '/img',
    (req, res, next) => (IMAGE_EXTENSIONS.test(req.path) ? next() : res.status(404).end()),
    express.static(path.join(rootDir, 'img'), {
      dotfiles: 'ignore',
      index: false,
      redirect: false,
      maxAge: '1d',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.svg')) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      },
    }),
  );

  app.use((req, res) => res.status(404).type('text').send('No encontrado'));

  // --- Errores ----------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof CheckoutError) {
      return res.status(err.status).json({ ...errorBody(err.code, err.message), ...(err.field ? { field: err.field } : {}) });
    }
    if (err.type === 'entity.too.large') return res.status(413).json(errorBody('body_demasiado_grande', 'El pedido es demasiado grande.'));
    if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
      return res.status(400).json(errorBody('json_invalido', 'El cuerpo no es un JSON válido.'));
    }
    logger.error('error_interno', { requestId: req.id, kind: err instanceof CatalogError ? 'catalogo' : 'inesperado', reason: err.message });
    return res.status(500).json(errorBody('error_interno', 'Ocurrió un error. Probá de nuevo en unos minutos.'));
  });

  return app;
}

function start() {
  try {
    process.loadEnvFile(path.join(__dirname, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  const server = app.listen(port, host, () => {
    consoleLogger.info('server.listening', { url: `http://${host}:${port}` });
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp };
