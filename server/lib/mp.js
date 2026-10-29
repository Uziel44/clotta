'use strict';

const crypto = require('node:crypto');

const MP_BASE_URL = 'https://api.mercadopago.com';

class MpError extends Error {
  constructor(message, { status = null, mpMessage = null } = {}) {
    super(message);
    this.name = 'MpError';
    this.status = status;
    this.mpMessage = mpMessage;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
    || /^127\./.test(hostname) || hostname.endsWith('.localhost');
}

// Mercado Pago solo acepta notification_url y auto_return con URLs publicas https.
// Con localhost la preferencia se crea igual (los back_urls quedan, el boton
// "Volver al sitio" puede funcionar) pero no hay webhook ni redireccion automatica.
function publicUrlInfo(publicUrl) {
  const url = new URL(publicUrl);
  return { isHttps: url.protocol === 'https:', isLocal: isLocalHost(url.hostname) };
}

// El envio NO se cobra online: el total son solo las prendas. receiver_address va como
// ayuda para el vendedor en el panel de Mercado Pago.
function buildPreference({ order, orderId, buyer = {}, delivery = null, publicUrl, installments }) {
  const { isHttps } = publicUrlInfo(publicUrl);
  const items = order.lines.map((line) => {
    const item = {
      id: line.id,
      title: line.title,
      quantity: line.qty,
      unit_price: line.unitPrice,
      currency_id: order.currency,
    };
    if (isHttps && line.image) item.picture_url = new URL(line.image, `${publicUrl}/`).href;
    return item;
  });

  const preference = {
    items,
    external_reference: orderId,
    back_urls: {
      success: `${publicUrl}/?pago=exito`,
      pending: `${publicUrl}/?pago=pendiente`,
      failure: `${publicUrl}/?pago=error`,
    },
    statement_descriptor: 'CLOTTA',
    metadata: { order_id: orderId, source: 'clotta-web' },
  };
  if (delivery?.method) preference.metadata.delivery_method = delivery.method;
  if (delivery?.method === 'envio' && delivery.address) {
    const { street, number, zip } = delivery.address;
    const receiver = { zip_code: zip, street_name: street };
    // street_number solo si es numerico: Mercado Pago lo valida como numero.
    if (/^\d{1,10}$/.test(number ?? '')) receiver.street_number = number;
    preference.shipments = { receiver_address: receiver };
  }
  if (Number.isInteger(installments) && installments > 0) {
    preference.payment_methods = { installments };
  }
  if (isHttps) {
    preference.auto_return = 'approved';
    preference.notification_url = `${publicUrl}/api/webhook`;
  }
  const payer = {};
  if (buyer.name) payer.name = buyer.name;
  if (buyer.email) payer.email = buyer.email;
  const phoneDigits = (buyer.phone ?? '').replace(/\D/g, '');
  if (phoneDigits) payer.phone = { number: phoneDigits };
  if (Object.keys(payer).length > 0) preference.payer = payer;
  return preference;
}

function createMpClient({
  fetch = globalThis.fetch,
  accessToken,
  baseUrl = MP_BASE_URL,
  timeoutMs = 10_000,
  retryDelayMs = 300,
}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(method, path, { body, headers = {}, retries = 0 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new MpError('Mercado Pago no respondió');
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new MpError('Respuesta de Mercado Pago ilegible', { status: res.status });
        }
      }
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      const detail = await res.json().catch(() => ({}));
      const mpMessage = typeof detail?.message === 'string' ? detail.message.split(accessToken).join('[redacted]').slice(0, 200) : null;
      throw new MpError(`Mercado Pago respondió ${res.status}`, { status: res.status, mpMessage });
    }
  }

  return {
    // La key es el orderId: un reintento nuestro por red/5xx no duplica la preferencia.
    async createPreference(preference, idempotencyKey) {
      const created = await request('POST', '/checkout/preferences', {
        body: preference,
        headers: { 'X-Idempotency-Key': idempotencyKey },
        retries: 1,
      });
      if (typeof created?.init_point !== 'string' || typeof created?.id !== 'string') {
        throw new MpError('Mercado Pago no devolvió init_point');
      }
      return { id: created.id, initPoint: created.init_point };
    },

    // Sin reintentos: si falla, respondemos 5xx y es Mercado Pago quien reintenta el webhook.
    // Devuelve null si el pago no existe (404), p. ej. con las notificaciones de prueba.
    async getPayment(paymentId) {
      try {
        return await request('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
      } catch (err) {
        if (err instanceof MpError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

function parseSignatureHeader(header) {
  if (typeof header !== 'string') return null;
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return index === -1 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
  return parts.ts && parts.v1 ? { ts: parts.ts, v1: parts.v1 } : null;
}

// Manifest oficial: id:<data.id de la query>;request-id:<x-request-id>;ts:<ts>;
// (un campo ausente se omite; data.id va en minuscula).
function buildSignatureManifest({ dataId, requestId, ts }) {
  return [
    dataId ? `id:${String(dataId).toLowerCase()};` : '',
    requestId ? `request-id:${requestId};` : '',
    `ts:${ts};`,
  ].join('');
}

function verifyWebhookSignature({ secret, signatureHeader, requestId, dataId }) {
  const signature = parseSignatureHeader(signatureHeader);
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(buildSignatureManifest({ dataId, requestId, ts: signature.ts }))
    .digest();
  if (!/^[0-9a-f]{64}$/i.test(signature.v1)) return false;
  return crypto.timingSafeEqual(expected, Buffer.from(signature.v1, 'hex'));
}

module.exports = {
  MpError,
  publicUrlInfo,
  buildPreference,
  createMpClient,
  buildSignatureManifest,
  verifyWebhookSignature,
};
