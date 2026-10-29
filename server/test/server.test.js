'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUYER,
  CANARY,
  ENVIO,
  FIXTURE_CATALOG,
  PII_VALUES,
  RETIRO,
  TOKEN,
  WEBHOOK_SECRET,
  cartBody,
  makeFakeMp,
  postJson,
  rawGet,
  readJsonl,
  signWebhook,
  startApp,
} = require('./helpers');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEMS = [{ id: 'jean', qty: 2, size: 'S', color: 'Azul' }, { id: 'remera', qty: 1 }];
const CART = cartBody(ITEMS);

async function withApp(options, fn) {
  const app = await startApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------- health / headers / CORS

test('GET /api/health informa si Mercado Pago está configurado', async () => {
  await withApp({}, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, mpConfigured: true });
  });
  await withApp({ withToken: false }, async (app) => {
    assert.deepEqual(await (await fetch(`${app.baseUrl}/api/health`)).json(), { ok: true, mpConfigured: false });
  });
});

test('cabeceras de seguridad, sin x-powered-by y API sin caché', async () => {
  await withApp({}, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(res.headers.get('strict-transport-security'), /max-age/, 'PUBLIC_URL es https');
    assert.match(res.headers.get('x-request-id'), UUID);
  });
});

test('CORS: solo orígenes permitidos; preflight 204', async () => {
  await withApp({}, async (app) => {
    const allowed = await fetch(`${app.baseUrl}/api/health`, { headers: { Origin: 'http://localhost:5502' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5502');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const publicOrigin = await fetch(`${app.baseUrl}/api/health`, { headers: { Origin: 'https://clotta.example.com' } });
    assert.equal(publicOrigin.headers.get('access-control-allow-origin'), 'https://clotta.example.com');

    const other = await fetch(`${app.baseUrl}/api/health`, { headers: { Origin: 'https://malo.example.org' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${app.baseUrl}/api/checkout`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5502', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5502');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);
  });
});

test('ALLOWED_ORIGINS por env reemplaza el default', async () => {
  await withApp({ env: { ALLOWED_ORIGINS: 'http://localhost:8080' } }, async (app) => {
    const old = await fetch(`${app.baseUrl}/api/health`, { headers: { Origin: 'http://localhost:5502' } });
    assert.equal(old.headers.get('access-control-allow-origin'), null);
    const next = await fetch(`${app.baseUrl}/api/health`, { headers: { Origin: 'http://localhost:8080' } });
    assert.equal(next.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  });
});

// ---------------------------------------------------------------- checkout

test('checkout OK: precios del catálogo, preferencia bien armada y {init_point, orderId}', async () => {
  await withApp({}, async (app) => {
    const body = {
      items: [
        { id: 'jean', qty: 2, size: 'S', color: 'Azul', price: 1, unit_price: 1 },
        { id: 'remera', qty: 1, price: 1 },
      ],
      buyer: { ...BUYER, vip: true },
      delivery: ENVIO,
      total: 1,
    };
    const res = await postJson(app.baseUrl, '/api/checkout', body);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(Object.keys(json).sort(), ['init_point', 'orderId']);
    assert.match(json.orderId, UUID);
    assert.equal(json.init_point, 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1');

    assert.equal(app.mp.calls.length, 1);
    const [call] = app.mp.calls;
    assert.equal(call.url, 'https://api.mercadopago.com/checkout/preferences');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['X-Idempotency-Key'], json.orderId);
    assert.equal(call.body.external_reference, json.orderId);
    assert.deepEqual(
      call.body.items.map((i) => [i.id, i.quantity, i.unit_price, i.currency_id]),
      [['jean', 2, 80000, 'ARS'], ['remera', 1, 30000, 'ARS']],
    );
    assert.deepEqual(call.body.payment_methods, { installments: 3 });
    assert.equal(call.body.back_urls.success, 'https://clotta.example.com/?pago=exito');
    assert.equal(call.body.notification_url, 'https://clotta.example.com/api/webhook');
    assert.equal(call.body.auto_return, 'approved');
    assert.deepEqual(call.body.payer, { name: 'Zulema Quispe', email: 'zulema.quispe@example.org', phone: { number: '543515550123' } });
    assert.deepEqual(call.body.shipments, { receiver_address: { zip_code: 'X5016ABC', street_name: 'Calle Secreta', street_number: '1234' } });
    assert.deepEqual(call.body.metadata, { order_id: json.orderId, source: 'clotta-web', delivery_method: 'envio' });
    const charged = call.body.items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
    assert.equal(charged, 190000, 'el envío no se cobra online');

    const pending = readJsonl(path.join(app.fixture.dataDir, 'pending.jsonl'));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].orderId, json.orderId);
    assert.equal(pending[0].total, 190000);
    assert.deepEqual(pending[0].buyer, BUYER, 'comprador completo, sin campos de más');
    assert.deepEqual(pending[0].delivery, ENVIO, 'entrega completa con dirección y notas');
  });
});

test('checkout con retiro: la dirección que venga se ignora y no se guarda ni se envía', async () => {
  await withApp({}, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', {
      items: ITEMS,
      buyer: BUYER,
      delivery: { method: 'retiro', notes: 'Paso a la tarde', address: { street: '<roto>', city: '', zip: 'x' } },
    });
    assert.equal(res.status, 200);
    const [call] = app.mp.calls;
    assert.equal(call.body.shipments, undefined);
    assert.equal(call.body.metadata.delivery_method, 'retiro');
    const [pending] = readJsonl(path.join(app.fixture.dataDir, 'pending.jsonl'));
    assert.deepEqual(pending.delivery, { method: 'retiro', notes: 'Paso a la tarde' });
  });
});

test('checkout con PUBLIC_URL por defecto (localhost): crea la preferencia sin webhook ni auto_return', async () => {
  await withApp({ env: { PUBLIC_URL: '', PORT: '3000' } }, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', cartBody([{ id: 'remera', qty: 1 }]));
    assert.equal(res.status, 200);
    const { body } = app.mp.calls[0];
    assert.equal(body.back_urls.success, 'http://localhost:3000/?pago=exito');
    assert.equal(body.auto_return, undefined);
    assert.equal(body.notification_url, undefined);
  });
});

test('checkout 400: cada código de error con su mensaje, sin llamar a Mercado Pago', async () => {
  const cases = [
    ['items_vacios', {}],
    ['items_vacios', { items: [] }],
    ['demasiados_items', { items: Array.from({ length: 21 }, () => ({ id: 'remera', qty: 1 })) }],
    ['producto_inexistente', { items: [{ id: 'nada', qty: 1 }] }],
    ['sin_stock', { items: [{ id: 'agotado', qty: 1 }] }],
    ['cantidad_invalida', { items: [{ id: 'remera', qty: 0 }] }],
    ['cantidad_invalida', { items: [{ id: 'remera', qty: 11 }] }],
    ['talle_invalido', { items: [{ id: 'jean', qty: 1, color: 'Azul' }] }],
    ['talle_invalido', { items: [{ id: 'jean', qty: 1, size: 'XL', color: 'Azul' }] }],
    ['color_invalido', { items: [{ id: 'jean', qty: 1, size: 'S', color: 'Rojo' }] }],
  ];
  await withApp({}, async (app) => {
    for (const [code, body] of cases) {
      const res = await postJson(app.baseUrl, '/api/checkout', body);
      assert.equal(res.status, 400, code);
      const json = await res.json();
      assert.equal(json.code, code);
      assert.equal(typeof json.error, 'string');
      assert.ok(json.error.length > 5);
      assert.equal('field' in json, false, 'los errores de items no llevan field');
    }
    assert.equal(app.mp.calls.length, 0);
  });
});

test('checkout 400: comprador y entrega inválidos -> código y field; nunca repite lo enviado', async () => {
  const cases = [
    ['buyer_invalido', 'buyer', { items: ITEMS, delivery: RETIRO }],
    ['buyer_invalido', 'buyer.name', cartBody(ITEMS, { buyer: { ...BUYER, name: 'A' } })],
    ['buyer_invalido', 'buyer.email', cartBody(ITEMS, { buyer: { ...BUYER, email: 'no-es-mail' } })],
    ['buyer_invalido', 'buyer.phone', cartBody(ITEMS, { buyer: { ...BUYER, phone: '12' } })],
    ['entrega_invalida', 'delivery', { items: ITEMS, buyer: BUYER }],
    ['entrega_invalida', 'delivery.method', cartBody(ITEMS, { delivery: { method: 'correo' } })],
    ['entrega_invalida', 'delivery.notes', cartBody(ITEMS, { delivery: { method: 'retiro', notes: 'n'.repeat(201) } })],
    ['direccion_invalida', 'delivery.address', cartBody(ITEMS, { delivery: { method: 'envio' } })],
    ['direccion_invalida', 'delivery.address.street', cartBody(ITEMS, { delivery: { method: 'envio', address: { ...ENVIO.address, street: '' } } })],
    ['direccion_invalida', 'delivery.address.city', cartBody(ITEMS, { delivery: { method: 'envio', address: { ...ENVIO.address, city: undefined } } })],
    ['direccion_invalida', 'delivery.address.province', cartBody(ITEMS, { delivery: { method: 'envio', address: { ...ENVIO.address, province: '<b>' } } })],
    ['direccion_invalida', 'delivery.address.zip', cartBody(ITEMS, { delivery: { method: 'envio', address: { ...ENVIO.address, zip: '1' } } })],
  ];
  await withApp({}, async (app) => {
    for (const [code, field, body] of cases) {
      const res = await postJson(app.baseUrl, '/api/checkout', body);
      assert.equal(res.status, 400, `${code} ${field}`);
      const text = await res.text();
      const json = JSON.parse(text);
      assert.deepEqual([json.code, json.field], [code, field]);
      assert.equal(typeof json.error, 'string');
      for (const value of PII_VALUES) assert.ok(!text.includes(value), `la respuesta repite "${value}"`);
    }
    // los items se validan primero: carrito malo + comprador malo -> error de items
    const both = await postJson(app.baseUrl, '/api/checkout', { items: [], buyer: {} });
    assert.equal((await both.json()).code, 'items_vacios');
    assert.equal(app.mp.calls.length, 0);
    assert.equal(fs.existsSync(path.join(app.fixture.dataDir, 'pending.jsonl')), false);
  });
});

test('checkout: Content-Type no JSON -> 415, JSON roto -> 400, cuerpo grande -> 413', async () => {
  await withApp({}, async (app) => {
    const form = await fetch(`${app.baseUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(CART),
    });
    assert.equal(form.status, 415);
    assert.equal((await form.json()).code, 'content_type_invalido');

    const broken = await postJson(app.baseUrl, '/api/checkout', '{"items": [');
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).code, 'json_invalido');

    const big = await postJson(app.baseUrl, '/api/checkout', JSON.stringify({ items: [{ id: 'remera', qty: 1 }], nota: 'x'.repeat(60_000) }));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).code, 'body_demasiado_grande');
    assert.equal(app.mp.calls.length, 0);
  });
});

test('checkout sin MP_ACCESS_TOKEN -> 503 pagos_no_configurados y no toca la red', async () => {
  await withApp({ withToken: false }, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', CART);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'pagos_no_configurados');
    assert.equal(app.mp.calls.length, 0);
    assert.equal(fs.existsSync(path.join(app.fixture.dataDir, 'pending.jsonl')), false);
  });
});

test('checkout con Mercado Pago caído -> 502 genérico: ni el token ni el detalle salen al cliente ni a los logs', async () => {
  const fake = makeFakeMp();
  fake.override = () => Response.json({ message: `error interno con ${TOKEN}`, cause: 'x' }, { status: 500 });
  await withApp({ fetch: fake }, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', CART);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.equal(JSON.parse(text).code, 'mp_error');
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes('error interno'));
    assert.equal(fake.calls.length, 2, 'un reintento ante 5xx');
    assert.equal(fake.calls[0].headers['X-Idempotency-Key'], fake.calls[1].headers['X-Idempotency-Key']);
    assert.ok(!JSON.stringify(app.logs).includes(TOKEN), 'el token no aparece en los logs');
    assert.equal(fs.existsSync(path.join(app.fixture.dataDir, 'pending.jsonl')), false);
  });
});

test('checkout con fallo de red hacia Mercado Pago -> 502', async () => {
  const fake = async () => {
    throw new Error('ECONNRESET');
  };
  await withApp({ fetch: fake }, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', CART);
    assert.equal(res.status, 502);
  });
});

test('la fila pendiente no se guarda si falla el disco, pero la venta sigue', async () => {
  await withApp({}, async (app) => {
    // dataDir ocupado por un archivo: mkdir falla y el pendiente no se puede escribir
    fs.mkdirSync(path.dirname(app.fixture.dataDir), { recursive: true });
    fs.writeFileSync(app.fixture.dataDir, 'archivo, no carpeta');
    const res = await postJson(app.baseUrl, '/api/checkout', CART);
    assert.equal(res.status, 200);
    assert.ok(app.logs.some((l) => l.msg === 'checkout.pending_not_saved'));
  });
});

test('rate limit de checkout: 20 por minuto por IP, el 21 es 429 con Retry-After', async () => {
  await withApp({ withToken: false }, async (app) => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await postJson(app.baseUrl, '/api/checkout', CART)).status, 503);
    }
    const res = await postJson(app.baseUrl, '/api/checkout', CART);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.equal((await res.json()).code, 'demasiadas_solicitudes');
  });
});

test('editar un precio en catalog.json se refleja sin reiniciar', async () => {
  await withApp({}, async (app) => {
    const edited = structuredClone(FIXTURE_CATALOG);
    edited.products.find((p) => p.id === 'remera').price = 45000;
    fs.writeFileSync(app.fixture.catalogPath, JSON.stringify(edited));
    const when = new Date(Date.now() + 5000);
    fs.utimesSync(app.fixture.catalogPath, when, when);

    const res = await postJson(app.baseUrl, '/api/checkout', cartBody([{ id: 'remera', qty: 1 }]));
    assert.equal(res.status, 200);
    assert.equal(app.mp.calls[0].body.items[0].unit_price, 45000);
  });
});

test('catálogo inválido sin versión previa -> 500 genérico', async () => {
  await withApp({}, async (app) => {
    fs.writeFileSync(app.fixture.catalogPath, 'no es json');
    const res = await postJson(app.baseUrl, '/api/checkout', CART);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'error_interno');
    assert.equal(app.mp.calls.length, 0);
  });
});

test('rutas /api inexistentes -> 404 JSON', async () => {
  await withApp({}, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/nada`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'no_encontrado');
  });
});

// ---------------------------------------------------------------- webhook

const PAID = {
  status: 'approved',
  transaction_amount: 190000,
  currency_id: 'ARS',
  external_reference: null,
  payer: { email: 'pagador@mail.com' },
};

function webhookUrl(app, dataId = '777') {
  return `${app.baseUrl}/api/webhook?data.id=${dataId}&type=payment`;
}

async function createOrder(app) {
  const res = await postJson(app.baseUrl, '/api/checkout', cartBody(ITEMS, { delivery: ENVIO }));
  return (await res.json()).orderId;
}

function notify(app, { dataId = '777', body, headers } = {}) {
  return postJson(app.baseUrl, `/api/webhook?data.id=${dataId}&type=payment`, body ?? { action: 'payment.updated', type: 'payment', data: { id: dataId } }, headers);
}

test('webhook con firma inválida o ausente -> 401 y no consulta a Mercado Pago', async () => {
  await withApp({ env: { MP_WEBHOOK_SECRET: WEBHOOK_SECRET } }, async (app) => {
    assert.equal((await notify(app)).status, 401, 'sin firma');
    assert.equal((await notify(app, { headers: { 'x-signature': 'ts=1,v1=' + '0'.repeat(64), 'x-request-id': 'r' } })).status, 401, 'firma falsa');
    const signedForOther = signWebhook({ dataId: '111' });
    assert.equal((await notify(app, { dataId: '777', headers: signedForOther })).status, 401, 'firma de otro data.id');
    assert.equal(app.mp.calls.length, 0);
    assert.equal(readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl')).length, 0);
  });
});

test('webhook firmado + pago aprobado -> registra el pedido con items y comprador', async () => {
  const fake = makeFakeMp();
  await withApp({ fetch: fake, env: { MP_WEBHOOK_SECRET: WEBHOOK_SECRET } }, async (app) => {
    const orderId = await createOrder(app);
    fake.calls.length = 0;
    const paid = { ...PAID, external_reference: orderId };
    fake.override = (call) => (call.method === 'GET' ? Response.json(paid) : null);

    const res = await notify(app, { headers: signWebhook({ dataId: '777' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, recorded: true });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.mercadopago.com/v1/payments/777');
    assert.equal(fake.calls[0].headers.Authorization, `Bearer ${TOKEN}`);

    const orders = readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl'));
    assert.equal(orders.length, 1);
    assert.equal(orders[0].orderId, orderId);
    assert.equal(orders[0].paymentId, '777');
    assert.equal(orders[0].amount, 190000);
    assert.equal(orders[0].amountMatches, true);
    assert.deepEqual(orders[0].buyer, BUYER, 'el webhook copia el comprador del pedido pendiente');
    assert.deepEqual(orders[0].delivery, ENVIO, 'y la entrega completa');
    assert.deepEqual(orders[0].items.map((i) => [i.id, i.qty, i.size, i.color, i.unitPrice]), [
      ['jean', 2, 'S', 'Azul', 80000],
      ['remera', 1, null, null, 30000],
    ]);
  });
});

test('webhook idempotente: el mismo pago, secuencial o en paralelo, se registra una sola vez', async () => {
  const fake = makeFakeMp({ payments: { 777: { ...PAID, external_reference: 'orden-x' } } });
  await withApp({ fetch: fake, env: { MP_WEBHOOK_SECRET: WEBHOOK_SECRET } }, async (app) => {
    const signed = () => ({ headers: signWebhook({ dataId: '777' }) });
    const results = await Promise.all([notify(app, signed()), notify(app, signed()), notify(app, signed())]);
    assert.ok(results.every((r) => r.status === 200));
    const again = await notify(app, signed());
    assert.deepEqual(await again.json(), { ok: true, recorded: false });
    assert.equal(readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl')).length, 1);
  });
});

test('webhook: pago no aprobado no se registra, aunque el payload diga lo contrario', async () => {
  const fake = makeFakeMp({ payments: { 777: { ...PAID, status: 'pending' } } });
  await withApp({ fetch: fake, env: { MP_WEBHOOK_SECRET: WEBHOOK_SECRET } }, async (app) => {
    const res = await notify(app, {
      headers: signWebhook({ dataId: '777' }),
      body: { type: 'payment', data: { id: '777' }, status: 'approved', transaction_amount: 1 },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: 'pending' });
    assert.equal(readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl')).length, 0);
  });
});

test('webhook: monto distinto al pedido se registra marcado y deja un warning', async () => {
  const fake = makeFakeMp();
  await withApp({ fetch: fake }, async (app) => {
    const orderId = await createOrder(app);
    fake.override = (call) => (call.method === 'GET' ? Response.json({ ...PAID, external_reference: orderId, transaction_amount: 1000 }) : null);
    const res = await notify(app);
    assert.equal(res.status, 200);
    const [order] = readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl'));
    assert.equal(order.amountMatches, false);
    assert.ok(app.logs.some((l) => l.msg === 'webhook.monto_distinto' && l.expected === 190000 && l.received === 1000));
  });
});

test('webhook: pago sin pedido pendiente usa additional_info.items como respaldo', async () => {
  const fake = makeFakeMp({
    payments: {
      777: { ...PAID, external_reference: 'otro-sistema', additional_info: { items: [{ id: 'remera', title: 'Remera', quantity: '1', unit_price: '30000' }] } },
    },
  });
  await withApp({ fetch: fake }, async (app) => {
    await notify(app);
    const [order] = readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl'));
    assert.equal(order.amountMatches, null);
    assert.deepEqual(order.items, [{ id: 'remera', name: 'Remera', qty: 1, unitPrice: 30000 }]);
    assert.deepEqual(order.buyer, { email: 'pagador@mail.com' });
    assert.equal(order.delivery, null);
  });
});

// ---------------------------------------------------------------- privacidad

function assertNoPii(label, haystack) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  for (const value of PII_VALUES) assert.ok(!text.includes(value), `${label} filtra "${value}"`);
}

test('privacidad: ni un checkout exitoso ni su webhook dejan email, teléfono ni dirección en los logs', async () => {
  const fake = makeFakeMp();
  await withApp({ fetch: fake, env: { MP_WEBHOOK_SECRET: WEBHOOK_SECRET } }, async (app) => {
    const orderId = await createOrder(app);
    fake.override = (call) =>
      call.method === 'GET'
        ? Response.json({ ...PAID, external_reference: orderId, payer: { email: BUYER.email }, additional_info: { payer: { first_name: BUYER.name } } })
        : null;
    assert.equal((await notify(app, { headers: signWebhook({ dataId: '777' }) })).status, 200);

    assert.ok(app.logs.some((l) => l.msg === 'checkout.created'));
    assert.ok(app.logs.some((l) => l.msg === 'webhook.pago_aprobado'));
    assertNoPii('logs', app.logs);
    // y los datos sí quedaron donde corresponde: el registro del pedido
    const [order] = readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl'));
    assert.equal(order.buyer.email, BUYER.email);
    assert.equal(order.delivery.address.street, 'Calle Secreta');
  });
});

test('privacidad: si Mercado Pago rechaza y repite los datos del comprador, ni logs ni respuesta los muestran', async () => {
  const fake = makeFakeMp();
  fake.override = () =>
    Response.json(
      { message: `invalid payer ${BUYER.email} / ${BUYER.phone} / 3515550123 / ${BUYER.name} / Calle Secreta, Villa Ficticia X5016ABC / Dejar con el portero` },
      { status: 400 },
    );
  await withApp({ fetch: fake }, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', cartBody(ITEMS, { delivery: ENVIO }));
    assert.equal(res.status, 502);
    assertNoPii('respuesta 502', await res.text());
    const failure = app.logs.find((l) => l.msg === 'checkout.mp_failed');
    assert.ok(failure, 'se loguea el fallo');
    assert.match(failure.mpMessage, /invalid payer/);
    assertNoPii('logs', app.logs);
  });
});

test('privacidad: los rechazos de validación no loguean nada del comprador', async () => {
  await withApp({}, async (app) => {
    const res = await postJson(app.baseUrl, '/api/checkout', cartBody(ITEMS, { buyer: { ...BUYER, email: 'zulema.quispe@example.org<' }, delivery: ENVIO }));
    assert.equal(res.status, 400);
    assertNoPii('respuesta 400', await res.text());
    assertNoPii('logs', app.logs);
  });
});

test('webhook sin MP_WEBHOOK_SECRET: procesa igual y avisa con un warning', async () => {
  const fake = makeFakeMp({ payments: { 777: { ...PAID, external_reference: 'x' } } });
  await withApp({ fetch: fake }, async (app) => {
    assert.equal((await notify(app)).status, 200);
    assert.ok(app.logs.some((l) => l.msg === 'webhook.sin_verificar'));
    assert.equal(readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl')).length, 1);
  });
});

test('webhook: otros tipos se ignoran; data.id no numérico -> 400; pago inexistente -> 200', async () => {
  const fake = makeFakeMp();
  await withApp({ fetch: fake, env: { MP_WEBHOOK_SECRET: WEBHOOK_SECRET } }, async (app) => {
    const other = await postJson(app.baseUrl, '/api/webhook?data.id=5&type=merchant_order', { type: 'merchant_order' }, signWebhook({ dataId: '5' }));
    assert.deepEqual(await other.json(), { ok: true, ignored: 'tipo_no_soportado' });
    assert.equal(fake.calls.length, 0);

    const weird = await postJson(app.baseUrl, '/api/webhook?data.id=..%2Fx&type=payment', { type: 'payment' }, signWebhook({ dataId: '../x' }));
    assert.equal(weird.status, 400);
    assert.equal(fake.calls.length, 0);

    const missing = await notify(app, { dataId: '123456', headers: signWebhook({ dataId: '123456' }) });
    assert.deepEqual(await missing.json(), { ok: true, ignored: 'pago_inexistente' });
  });
});

test('webhook: si Mercado Pago falla -> 502 para que reintente; sin token -> 503', async () => {
  const fake = makeFakeMp();
  fake.override = () => Response.json({}, { status: 500 });
  await withApp({ fetch: fake }, async (app) => {
    assert.equal((await notify(app)).status, 502);
    assert.equal(readJsonl(path.join(app.fixture.dataDir, 'orders.jsonl')).length, 0);
  });
  await withApp({ withToken: false }, async (app) => {
    assert.equal((await notify(app)).status, 503);
  });
});

// ---------------------------------------------------------------- sitio estático (whitelist)

test('sirve index.html, catalog.json e imágenes permitidas', async () => {
  await withApp({}, async (app) => {
    for (const route of ['/', '/index.html']) {
      const res = await fetch(`${app.baseUrl}${route}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>Clotta<\/title>/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
    }
    const catalog = await fetch(`${app.baseUrl}/catalog.json`);
    assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), FIXTURE_CATALOG);
    const img = await fetch(`${app.baseUrl}/img/a.webp`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/webp');
  });
});

test('NO sirve nada fuera de la whitelist: .env, PDFs, bench, .htm de img/ ni traversal', async () => {
  await withApp({}, async (app) => {
    const paths = [
      '/server/.env',
      '/server/server.js',
      '/server/package.json',
      '/Clotta.pdf',
      '/bench/x.jpg',
      '/img/page.htm',
      '/img/',
      '/img',
      '/.env',
      '/index.html/../server/.env',
    ];
    for (const route of paths) {
      const res = await rawGet(app.port, route);
      assert.notEqual(res.status, 200, `${route} no debería servirse`);
      assert.ok(!res.body.includes(CANARY), `${route} filtró contenido`);
    }
    const traversal = [
      '/img/..%2fserver%2f.env',
      '/img/%2e%2e/server/.env',
      '/img/%2e%2e%2fClotta.pdf',
      '/img/..%5cClotta.pdf',
      '/img/a.webp/../../Clotta.pdf',
      '/img/%2e%2e/%2e%2e/etc/passwd',
      // con extensión de imagen permitida: acá solo frena el static de express
      '/img/..%2fbench%2fx.jpg',
      '/img/%2e%2e/bench/x.jpg',
      '/img/%2e%2e%2fbench%2fx.jpg',
    ];
    for (const route of traversal) {
      const res = await rawGet(app.port, route);
      assert.ok([400, 403, 404].includes(res.status), `${route} -> ${res.status}`);
      assert.ok(!res.body.includes(CANARY), `${route} filtró contenido`);
    }
  });
});

test('si falta index.html la raíz responde 404 sin romper el server', async () => {
  await withApp({}, async (app) => {
    fs.rmSync(path.join(app.fixture.root, 'index.html'));
    const res = await fetch(`${app.baseUrl}/`);
    assert.equal(res.status, 404);
    assert.equal((await fetch(`${app.baseUrl}/api/health`)).status, 200);
  });
});
