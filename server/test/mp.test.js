'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCatalog } = require('../lib/catalog');
const { buildOrder } = require('../lib/pricing');
const {
  MpError,
  buildPreference,
  buildSignatureManifest,
  createMpClient,
  verifyWebhookSignature,
} = require('../lib/mp');
const { FIXTURE_CATALOG, TOKEN, WEBHOOK_SECRET, makeFakeMp, signWebhook } = require('./helpers');

const catalog = parseCatalog(JSON.stringify(FIXTURE_CATALOG));
const order = buildOrder(catalog, [
  { id: 'jean', qty: 2, size: 'S', color: 'Azul' },
  { id: 'remera', qty: 1 },
]);
const ORDER_ID = '3f0c9c1e-6a53-4f7c-9a6e-0d5d0b6a1f11';

const BUYER_MP = { name: 'Ana Pérez', email: 'ana@mail.com', phone: '+54 351 617-6285' };
const ENVIO_MP = {
  method: 'envio',
  address: { street: 'Av. Richieri', number: '2872', city: 'Córdoba', province: 'Córdoba', zip: '5000' },
  notes: 'Timbre 3',
};

test('preferencia https: items, back_urls, cuotas, referencia, webhook y auto_return', () => {
  const pref = buildPreference({
    order,
    orderId: ORDER_ID,
    buyer: BUYER_MP,
    delivery: ENVIO_MP,
    publicUrl: 'https://clotta.example.com',
    installments: 3,
  });
  assert.deepEqual(pref.items[0], {
    id: 'jean',
    title: 'Jean · Talle S · Azul',
    quantity: 2,
    unit_price: 80000,
    currency_id: 'ARS',
    picture_url: 'https://clotta.example.com/img/a.webp',
  });
  assert.equal(pref.items[1].unit_price, 30000);
  assert.equal(pref.external_reference, ORDER_ID);
  assert.deepEqual(pref.back_urls, {
    success: 'https://clotta.example.com/?pago=exito',
    pending: 'https://clotta.example.com/?pago=pendiente',
    failure: 'https://clotta.example.com/?pago=error',
  });
  assert.equal(pref.auto_return, 'approved');
  assert.equal(pref.notification_url, 'https://clotta.example.com/api/webhook');
  assert.deepEqual(pref.payment_methods, { installments: 3 });
  assert.equal(pref.statement_descriptor, 'CLOTTA');
  assert.deepEqual(pref.metadata, { order_id: ORDER_ID, source: 'clotta-web', delivery_method: 'envio' });
  assert.deepEqual(pref.payer, { name: 'Ana Pérez', email: 'ana@mail.com', phone: { number: '543516176285' } });
  assert.deepEqual(pref.shipments, { receiver_address: { zip_code: '5000', street_name: 'Av. Richieri', street_number: '2872' } });
  for (const item of pref.items) assert.ok(Number.isInteger(item.unit_price));
  const charged = pref.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  assert.equal(charged, order.total, 'el envío no se cobra online: el total son solo las prendas');
});

test('preferencia con retiro: payer y metadata, sin shipments (ni address aunque venga)', () => {
  const pref = buildPreference({
    order,
    orderId: ORDER_ID,
    buyer: BUYER_MP,
    delivery: { method: 'retiro', address: ENVIO_MP.address },
    publicUrl: 'https://clotta.example.com',
    installments: 3,
  });
  assert.equal(pref.shipments, undefined);
  assert.deepEqual(pref.metadata, { order_id: ORDER_ID, source: 'clotta-web', delivery_method: 'retiro' });
  assert.deepEqual(pref.payer.phone, { number: '543516176285' });
});

test('shipments: street_number se omite si no es numérico y se manda sin él si falta', () => {
  const build = (number) =>
    buildPreference({
      order,
      orderId: ORDER_ID,
      buyer: BUYER_MP,
      delivery: { method: 'envio', address: { ...ENVIO_MP.address, number } },
      publicUrl: 'https://clotta.example.com',
    });
  assert.deepEqual(build('S/N').shipments.receiver_address, { zip_code: '5000', street_name: 'Av. Richieri' });
  assert.deepEqual(build(undefined).shipments.receiver_address, { zip_code: '5000', street_name: 'Av. Richieri' });
  assert.equal(build('12B').shipments.receiver_address.street_number, undefined);
});

test('preferencia con PUBLIC_URL local: sin auto_return, webhook ni picture_url; back_urls se mantienen', () => {
  for (const publicUrl of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
    const pref = buildPreference({ order, orderId: ORDER_ID, publicUrl, installments: 3 });
    assert.equal(pref.auto_return, undefined);
    assert.equal(pref.notification_url, undefined);
    assert.equal(pref.items[0].picture_url, undefined);
    assert.equal(pref.back_urls.success, `${publicUrl}/?pago=exito`);
    assert.equal(pref.payer, undefined);
  }
});

test('preferencia con http no local tampoco manda auto_return ni webhook', () => {
  const pref = buildPreference({ order, orderId: ORDER_ID, publicUrl: 'http://clotta.example.com', installments: 3 });
  assert.equal(pref.auto_return, undefined);
  assert.equal(pref.notification_url, undefined);
});

test('sin cuotas configuradas no se toca payment_methods', () => {
  const pref = buildPreference({ order, orderId: ORDER_ID, publicUrl: 'https://clotta.example.com', installments: undefined });
  assert.equal(pref.payment_methods, undefined);
});

test('manifest y firma del webhook', () => {
  assert.equal(buildSignatureManifest({ dataId: 'ABC123', requestId: 'r1', ts: '99' }), 'id:abc123;request-id:r1;ts:99;');
  assert.equal(buildSignatureManifest({ requestId: 'r1', ts: '99' }), 'request-id:r1;ts:99;');

  const headers = signWebhook({ dataId: '123456' });
  const ok = (overrides = {}) =>
    verifyWebhookSignature({
      secret: WEBHOOK_SECRET,
      signatureHeader: headers['x-signature'],
      requestId: headers['x-request-id'],
      dataId: '123456',
      ...overrides,
    });
  assert.equal(ok(), true);
  assert.equal(ok({ dataId: '999999' }), false, 'otro data.id');
  assert.equal(ok({ requestId: 'otro' }), false, 'otro request-id');
  assert.equal(ok({ secret: 'otro-secret' }), false, 'otro secret');
  assert.equal(ok({ signatureHeader: undefined }), false, 'sin header');
  assert.equal(ok({ signatureHeader: 'basura' }), false, 'header ilegible');
  assert.equal(ok({ signatureHeader: 'ts=1,v1=zz' }), false, 'v1 no hex');
  assert.equal(ok({ signatureHeader: 'ts=1,v1=abcd' }), false, 'v1 de largo incorrecto');
});

function client(fake, extra = {}) {
  return createMpClient({ fetch: fake, accessToken: TOKEN, retryDelayMs: 0, ...extra });
}

test('createPreference: Bearer, X-Idempotency-Key y cuerpo JSON', async () => {
  const fake = makeFakeMp();
  const created = await client(fake).createPreference({ items: [] }, ORDER_ID);
  assert.deepEqual(created, { id: 'pref-1', initPoint: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1' });
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.url, 'https://api.mercadopago.com/checkout/preferences');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers['X-Idempotency-Key'], ORDER_ID);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, { items: [] });
});

test('createPreference reintenta una vez ante 5xx con la MISMA idempotency key', async () => {
  const fake = makeFakeMp();
  let first = true;
  fake.override = () => {
    if (first) {
      first = false;
      return Response.json({ message: 'boom' }, { status: 503 });
    }
    return null;
  };
  const created = await client(fake).createPreference({ items: [] }, ORDER_ID);
  assert.equal(created.id, 'pref-1');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].headers['X-Idempotency-Key'], fake.calls[1].headers['X-Idempotency-Key']);
});

test('createPreference no reintenta un 4xx y el error no contiene el token', async () => {
  const fake = makeFakeMp();
  fake.override = () => Response.json({ message: 'invalid items' }, { status: 400 });
  await assert.rejects(client(fake).createPreference({ items: [] }, ORDER_ID), (err) => {
    assert.ok(err instanceof MpError);
    assert.equal(err.status, 400);
    assert.equal(err.mpMessage, 'invalid items');
    assert.ok(!JSON.stringify([err.message, err.mpMessage]).includes(TOKEN));
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test('createPreference: error de red dos veces -> MpError', async () => {
  const fake = async () => {
    throw new Error(`socket hang up (${TOKEN})`);
  };
  await assert.rejects(client(fake).createPreference({}, ORDER_ID), (err) => {
    assert.ok(err instanceof MpError);
    assert.ok(!err.message.includes(TOKEN), 'no filtra el mensaje original');
    return true;
  });
});

test('createPreference sin init_point en la respuesta -> MpError', async () => {
  const fake = makeFakeMp({ preference: { id: 'pref-1' } });
  await assert.rejects(client(fake).createPreference({}, ORDER_ID), MpError);
});

test('getPayment: 404 -> null, sin reintentos; 500 -> MpError', async () => {
  const fake = makeFakeMp();
  assert.equal(await client(fake).getPayment('123'), null);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, 'https://api.mercadopago.com/v1/payments/123');

  const broken = makeFakeMp();
  broken.override = () => Response.json({}, { status: 500 });
  await assert.rejects(client(broken).getPayment('123'), MpError);
  assert.equal(broken.calls.length, 1);
});
