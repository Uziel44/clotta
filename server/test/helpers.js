'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createApp } = require('../server');

const TOKEN = 'TEST-1234567890-SECRET-TOKEN-ABCDEF';
const WEBHOOK_SECRET = 'whsec_test_clotta';
const CANARY = 'CANARY_NO_DEBE_SERVIRSE';

const FIXTURE_CATALOG = {
  store: { name: 'CLOTTA', currency: 'ARS', installments: 3, transferDiscount: 0.2 },
  products: [
    { id: 'remera', name: 'Remera', price: 30000, sizes: [], colors: [], images: ['img/a.webp'] },
    { id: 'jean', name: 'Jean', price: 80000, sizes: ['S', 'M'], colors: ['Azul', 'Negro'], images: ['img/a.webp'] },
    { id: 'agotado', name: 'Agotado', price: 1000, sizes: [], colors: [], inStock: false, images: [] },
    { id: 'barato', name: 'Barato', price: 100, sizes: [], colors: [], images: [] },
  ],
};

// Datos personales de prueba, deliberadamente distintivos para poder buscarlos en logs y respuestas.
const BUYER = { name: 'Zulema Quispe', email: 'zulema.quispe@example.org', phone: '+54 351 555-0123' };
const ENVIO = {
  method: 'envio',
  address: { street: 'Calle Secreta', number: '1234', city: 'Villa Ficticia', province: 'Córdoba', zip: 'X5016ABC' },
  notes: 'Dejar con el portero',
};
const RETIRO = { method: 'retiro' };
const PII_VALUES = ['Zulema Quispe', 'zulema.quispe@example.org', '555-0123', '3515550123', 'Calle Secreta', 'Villa Ficticia', 'X5016ABC', 'Dejar con el portero'];

function cartBody(items, extra = {}) {
  return { items, buyer: BUYER, delivery: RETIRO, ...extra };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clotta-test-'));
  fs.mkdirSync(path.join(root, 'img'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Clotta</title>');
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(FIXTURE_CATALOG));
  fs.writeFileSync(path.join(root, 'img', 'a.webp'), 'webp-bytes');
  fs.writeFileSync(path.join(root, 'img', 'page.htm'), `<html>${CANARY}</html>`);
  fs.writeFileSync(path.join(root, 'server', '.env'), `MP_ACCESS_TOKEN=${CANARY}`);
  fs.writeFileSync(path.join(root, 'Clotta.pdf'), CANARY);
  fs.mkdirSync(path.join(root, 'bench'));
  fs.writeFileSync(path.join(root, 'bench', 'x.jpg'), CANARY);
  return {
    root,
    dataDir: path.join(root, 'server', 'data'),
    catalogPath: path.join(root, 'catalog.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// Mercado Pago simulado: registra cada llamada y responde segun el handler.
function makeFakeMp({ preference, payments = {} } = {}) {
  const calls = [];
  const fake = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (typeof fake.override === 'function') {
      const overridden = await fake.override(call);
      if (overridden) return overridden;
    }
    if (call.method === 'POST' && url.endsWith('/checkout/preferences')) {
      return Response.json(preference ?? { id: 'pref-1', init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1' });
    }
    const match = /\/v1\/payments\/([^/?]+)$/.exec(url);
    if (call.method === 'GET' && match) {
      const payment = payments[decodeURIComponent(match[1])];
      return payment ? Response.json(payment) : Response.json({ message: 'not found' }, { status: 404 });
    }
    return Response.json({ message: 'unexpected' }, { status: 500 });
  };
  fake.calls = calls;
  return fake;
}

async function startApp({ env = {}, fetch, fixture = makeFixture(), withToken = true } = {}) {
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (msg, fields = {}) => logs.push({ level, msg, ...fields })]));
  const mpFetch = fetch ?? makeFakeMp();
  const app = createApp({
    fetch: mpFetch,
    env: {
      PUBLIC_URL: 'https://clotta.example.com',
      ...(withToken ? { MP_ACCESS_TOKEN: TOKEN } : {}),
      ...env,
    },
    rootDir: fixture.root,
    dataDir: fixture.dataDir,
    catalogPath: fixture.catalogPath,
    logger,
    retryDelayMs: 0,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    fixture,
    logs,
    mp: mpFetch,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fixture.cleanup();
    },
  };
}

function postJson(baseUrl, route, body, headers = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Pedido HTTP crudo: fetch() normaliza ".." y "%2e%2e", y para probar traversal necesitamos el path tal cual.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function signWebhook({ secret = WEBHOOK_SECRET, dataId, requestId = 'req-1', ts = '1742505638683' }) {
  const manifest = [dataId ? `id:${String(dataId).toLowerCase()};` : '', requestId ? `request-id:${requestId};` : '', `ts:${ts};`].join('');
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = {
  TOKEN,
  WEBHOOK_SECRET,
  CANARY,
  FIXTURE_CATALOG,
  BUYER,
  ENVIO,
  RETIRO,
  PII_VALUES,
  cartBody,
  makeFixture,
  makeFakeMp,
  startApp,
  postJson,
  rawGet,
  signWebhook,
  readJsonl,
};
