'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createAuth } = require('./lib/auth');
const { CatalogError, createCatalogLoader, syncRepoSections } = require('./lib/catalog');
const { AdminError, createCatalogEditor } = require('./lib/catalog-editor');
const { createMetricsStore, normalizeEvent, summarize } = require('./lib/metrics');
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
const UPLOADED_FILE = /^\/[a-f0-9]{32}\.(?:jpg|png|webp)$/;
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DAY_MS = 24 * 60 * 60 * 1000;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
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
  const auth = createAuth({ env, logger });
  const editor = createCatalogEditor({ catalogPath, uploadsDir: path.join(dataDir, 'uploads') });
  const metrics = createMetricsStore(dataDir, { now });
  const mp = accessToken ? createMpClient({ fetch, accessToken, retryDelayMs }) : null;
  const checkoutLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, now });
  const webhookLimiter = createRateLimiter({ limit: 300, windowMs: 60_000, now });
  const loginLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000, now });
  const metricsLimiter = createRateLimiter({ limit: 120, windowMs: 60_000, now }); // de sobra para una persona; corta rafagas automaticas

  // Una vez al dia se descartan los eventos de metricas de mas de 90 dias.
  metrics.prune().catch((err) => logger.error('metrics.prune_fallo', { reason: err.message }));
  setInterval(() => metrics.prune().catch(() => {}), DAY_MS).unref();

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

  const limit = (limiter, name, message = 'Demasiados intentos. Esperá un minuto y probá de nuevo.') => (req, res, next) => {
    const result = limiter.check(req.ip);
    if (result.ok) return next();
    logger.warn('rate_limit', { route: name, requestId: req.id });
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json(errorBody('demasiadas_solicitudes', message));
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

  // --- Metricas: la pagina manda eventos anonimos, el panel los resume ---------
  app.post('/api/metrics', limit(metricsLimiter, 'metrics'), requireJson, express.json({ limit: '4kb', strict: true }), (req, res) => {
    const event = normalizeEvent(req.body, now());
    if (!event) return res.status(400).json(errorBody('evento_invalido', 'Evento inválido.'));
    metrics.record(event).catch((err) => logger.error('metrics.no_guardado', { reason: err.message }));
    return res.status(201).json({ ok: true });
  });

  // --- Panel (admin.html): un usuario, sesion con JWT ---------------------------
  app.post(
    '/api/login',
    limit(loginLimiter, 'login', 'Demasiados intentos. Probá de nuevo en unos minutos.'),
    requireJson,
    express.json({ limit: '4kb', strict: true }),
    async (req, res) => {
      if (!auth.enabled) {
        return res.status(503).json(errorBody('panel_no_configurado', 'El panel todavía no está habilitado en el servidor.'));
      }
      const { usuario, password } = isObject(req.body) ? req.body : {};
      const token = await auth.login(usuario, password);
      if (!token) {
        // No se loguea el usuario tipeado: a veces es la contrasena escrita en el campo equivocado.
        logger.warn('admin.login_fallido', { requestId: req.id });
        return res.status(401).json(errorBody('credenciales_invalidas', 'Usuario o contraseña incorrectos.'));
      }
      logger.info('admin.login', { requestId: req.id });
      return res.json({ token });
    },
  );

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!auth.enabled) return res.status(503).json(errorBody('panel_no_configurado', 'El panel todavía no está habilitado en el servidor.'));
    if (!auth.isValidRequest(req)) return res.status(401).json(errorBody('no_autorizado', 'La sesión no es válida o caducó. Iniciá sesión de nuevo.'));
    return next();
  });
  admin.get('/catalog', (req, res) => res.json(editor.view()));
  admin.post('/products', requireJson, jsonBody, async (req, res) => res.status(201).json(await editor.create(req.body)));
  admin.put('/products/:id', requireJson, jsonBody, async (req, res) => res.json(await editor.update(req.params.id, req.body)));
  admin.delete('/products/:id', async (req, res) => {
    await editor.remove(req.params.id);
    res.json({ ok: true });
  });
  admin.post('/images', (req, res, next) => {
    if (!req.is(UPLOAD_TYPES)) return res.status(415).json(errorBody('tipo_no_soportado', 'Subí una imagen JPG, PNG o WebP.'));
    return next();
  }, express.raw({ type: UPLOAD_TYPES, limit: '8mb' }), async (req, res) => {
    res.status(201).json({ url: await editor.saveImage(req.body) });
  });
  admin.get('/metrics', async (req, res) => {
    const productNames = new Map(editor.view().products.map((p) => [p.id, p.name]));
    res.json(summarize({ events: metrics.readEvents(), orders: await orders.listApproved(), productNames, now: now() }));
  });
  app.use('/api/admin', admin);

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
    ['/css/styles.css', 'css/styles.css'],
    ['/app.js', 'app.js'],
    ['/metricas.js', 'metricas.js'],
    ['/admin.html', 'admin.html'],
    ['/admin.css', 'admin.css'],
    ['/admin.js', 'admin.js'],
  ]);

  app.get([...PUBLIC_FILES.keys()], (req, res) => {
    // /catalog.json sale de catalogPath: en produccion vive en el volumen de datos (ver CATALOG_PATH).
    const file = req.path === '/catalog.json' ? catalogPath : path.join(rootDir, PUBLIC_FILES.get(req.path));
    const headers = { 'Cache-Control': 'no-cache', ...(req.path === '/admin.html' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) };
    res.sendFile(file, { dotfiles: 'allow', headers }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode === 404 ? 404 : 500).end();
    });
  });

  // Paginas de la tienda que genera generar-paginas.js: coleccion.html y una por categoria (denim.html, ...).
  // Solo se sirve un nombre que salga del catalogo, nunca un archivo cualquiera de la raiz.
  app.get(/^\/([a-z0-9-]+)\.html$/, (req, res, next) => {
    const slug = req.params[0];
    let allowed = slug === 'coleccion';
    if (!allowed) {
      try {
        allowed = editor.view().categories.some((c) => c.id === slug);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) return next();
    return res.sendFile(path.join(rootDir, `${slug}.html`), { dotfiles: 'ignore', headers: { 'Cache-Control': 'no-cache' } }, (err) => {
      if (err && !res.headersSent) next();
    });
  });

  // Imagenes subidas desde el panel: nombre aleatorio e inmutable, asi que cache largo.
  app.use(
    '/uploads',
    (req, res, next) => (UPLOADED_FILE.test(req.path) ? next() : res.status(404).end()),
    express.static(path.join(dataDir, 'uploads'), {
      dotfiles: 'ignore',
      index: false,
      redirect: false,
      maxAge: '365d',
      immutable: true,
    }),
  );

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
    if (err instanceof CheckoutError || err instanceof AdminError) {
      return res.status(err.status).json({ ...errorBody(err.code, err.message), ...(err.field ? { field: err.field } : {}) });
    }
    if (err.type === 'entity.too.large') return res.status(413).json(errorBody('body_demasiado_grande', 'El pedido o el archivo es demasiado grande.'));
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
  // En produccion el panel reescribe el catalogo, que tiene que sobrevivir a cada deploy: CATALOG_PATH lo
  // apunta al volumen de datos. La primera vez se siembra con el catalog.json que trae la imagen y, despues,
  // en cada arranque se actualizan desde ahi todas las secciones menos los productos.
  let catalogPath;
  if (process.env.CATALOG_PATH) {
    catalogPath = path.resolve(process.env.CATALOG_PATH);
    const seed = path.resolve(__dirname, '..', 'catalog.json');
    if (!fs.existsSync(catalogPath)) {
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
      fs.copyFileSync(seed, catalogPath);
      consoleLogger.info('catalog.sembrado', { from: 'catalog.json de la imagen' });
    } else {
      try {
        if (syncRepoSections(seed, catalogPath)) consoleLogger.info('catalog.secciones_actualizadas', { detail: 'tienda, categorias y portada tomadas del repo; los productos no se tocan' });
      } catch (err) {
        consoleLogger.error('catalog.sync_fallo', { reason: err.message });
      }
    }
  }
  const app = createApp({ catalogPath });
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
