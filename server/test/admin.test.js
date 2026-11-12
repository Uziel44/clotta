'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BUYER, makeFixture, postJson, rawGet, startApp } = require('./helpers');
const { normalizeEvent, summarize } = require('../lib/metrics');
const { slugify } = require('../lib/catalog-editor');

const PASSWORD = 'clave-de-prueba-123';
const ENV = { ADMIN_PASSWORD: PASSWORD, JWT_SECRET: 'secreto-de-prueba' };
const CATALOG = {
  store: { name: 'CLOTTA', currency: 'ARS', installments: 3, transferDiscount: 0.2 },
  categories: [{ id: 'remeras', name: 'Remeras' }, { id: 'denim', name: 'Denim' }],
  products: [
    { id: 'remera', name: 'Remera', category: 'remeras', price: 30000, colorCount: 2, colors: ['Blanco', 'Negro'], sizes: ['S'], slug: 'remera-abc', featured: true, inStock: true, description: 'Basica.', images: ['img/a.webp'] },
  ],
};
// Cabeceras minimas reales de cada formato (el servidor mira los bytes, no el Content-Type).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);

function fixtureWithCatalog() {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.catalogPath, JSON.stringify(CATALOG));
  fs.writeFileSync(path.join(fixture.root, 'admin.html'), '<!doctype html><title>Panel</title>');
  return fixture;
}

async function withPanel(fn, { env = ENV } = {}) {
  const app = await startApp({ env, fixture: fixtureWithCatalog() });
  try {
    const login = await postJson(app.baseUrl, '/api/login', { usuario: 'clotta', password: PASSWORD });
    const token = login.status === 200 ? (await login.json()).token : null;
    const authed = (route, init = {}) => fetch(`${app.baseUrl}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    const json = (route, method, body) => authed(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await fn({ ...app, token, authed, json });
  } finally {
    await app.close();
  }
}

const newProduct = (extra = {}) => ({ name: 'Blazer Nuevo', category: 'denim', price: 99000, colors: ['Azul'], sizes: ['S', 'M'], featured: false, inStock: true, description: 'Un blazer.', images: [], ...extra });
const readCatalog = (app) => JSON.parse(fs.readFileSync(app.fixture.catalogPath, 'utf8'));

// ---------------------------------------------------------------- usuario y sesion

test('sin contraseña configurada el panel queda deshabilitado, pero el sitio sigue andando', async () => {
  const app = await startApp({ fixture: fixtureWithCatalog() });
  try {
    const login = await postJson(app.baseUrl, '/api/login', { usuario: 'clotta', password: 'cualquiera' });
    assert.equal(login.status, 503);
    assert.equal((await login.json()).code, 'panel_no_configurado');
    assert.equal((await fetch(`${app.baseUrl}/api/admin/catalog`)).status, 503);
    assert.equal((await fetch(`${app.baseUrl}/`)).status, 200);
    assert.ok(app.logs.some((l) => l.msg === 'admin.sin_password'));
  } finally {
    await app.close();
  }
});

test('login: usuario o contraseña incorrectos dan el mismo 401 genérico; el correcto devuelve un token', async () => {
  await withPanel(async (app) => {
    const bad = [
      { usuario: 'clotta', password: 'otra' },
      { usuario: 'otro', password: PASSWORD },
      { usuario: 'clotta' },
      { usuario: 5, password: PASSWORD },
    ];
    const bodies = [];
    for (const body of bad) {
      const res = await postJson(app.baseUrl, '/api/login', body);
      assert.equal(res.status, 401);
      bodies.push(await res.json());
    }
    assert.ok(bodies.every((b) => b.code === 'credenciales_invalidas' && b.error === bodies[0].error));
    assert.match(app.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    const mayus = await postJson(app.baseUrl, '/api/login', { usuario: '  CLOTTA ', password: PASSWORD });
    assert.equal(mayus.status, 200);
  });
});

test('login: no se loguea el usuario ni la contraseña tipeados', async () => {
  await withPanel(async (app) => {
    await postJson(app.baseUrl, '/api/login', { usuario: 'MiClaveSecreta99', password: 'x' });
    assert.ok(app.logs.some((l) => l.msg === 'admin.login_fallido'));
    assert.ok(!JSON.stringify(app.logs).includes('MiClaveSecreta99'));
    assert.ok(!JSON.stringify(app.logs).includes(PASSWORD));
  });
});

test('login: tras 10 intentos por IP responde 429 con Retry-After', async () => {
  await withPanel(async (app) => {
    let last;
    for (let i = 0; i < 12; i += 1) last = await postJson(app.baseUrl, '/api/login', { usuario: 'clotta', password: 'mal' });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });
});

test('login: exige Content-Type JSON', async () => {
  await withPanel(async (app) => {
    const res = await fetch(`${app.baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(res.status, 415);
  });
});

test('hash bcrypt inválido: el panel queda deshabilitado y avisa en el log', async () => {
  const app = await startApp({ env: { ADMIN_PASSWORD_HASH: 'no-es-un-hash' }, fixture: fixtureWithCatalog() });
  try {
    assert.equal((await postJson(app.baseUrl, '/api/login', { usuario: 'clotta', password: 'x' })).status, 503);
    assert.ok(app.logs.some((l) => l.msg === 'admin.hash_invalido' && l.level === 'error'));
  } finally {
    await app.close();
  }
});

test('/api/admin/* rechaza sin token, con basura o con un token firmado con otro secreto', async () => {
  await withPanel(async (app) => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: 'clotta' }, 'otro-secreto', { algorithm: 'HS256' });
    const wrongUser = jwt.sign({ sub: 'intruso' }, ENV.JWT_SECRET, { algorithm: 'HS256' });
    const none = jwt.sign({ sub: 'clotta' }, '', { algorithm: 'none' });
    for (const auth of [undefined, 'Bearer', 'Bearer basura', `Bearer ${forged}`, `Bearer ${wrongUser}`, `Bearer ${none}`, `Basic ${app.token}`]) {
      const res = await fetch(`${app.baseUrl}/api/admin/catalog`, { headers: auth ? { Authorization: auth } : {} });
      assert.equal(res.status, 401, `Authorization: ${auth}`);
    }
    assert.equal((await app.authed('/api/admin/catalog')).status, 200);
  });
});

// ---------------------------------------------------------------- productos

test('GET /api/admin/catalog devuelve categorías y productos', async () => {
  await withPanel(async (app) => {
    const body = await (await app.authed('/api/admin/catalog')).json();
    assert.deepEqual(body.categories.map((c) => c.id), ['remeras', 'denim']);
    assert.equal(body.products[0].id, 'remera');
  });
});

test('crear producto: lo guarda en catalog.json con id derivado del nombre y el checkout ya lo vende', async () => {
  await withPanel(async (app) => {
    const res = await app.json('/api/admin/products', 'POST', newProduct({ name: 'Camisa Línea Ñandú' }));
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.id, 'camisa-linea-nandu');
    assert.deepEqual(created.colors, ['Azul']);
    assert.equal(created.colorCount, 1);
    const saved = readCatalog(app);
    assert.equal(saved.products.length, 2);
    assert.deepEqual(saved.categories, CATALOG.categories); // el resto del catálogo no se toca
    assert.deepEqual(saved.store, CATALOG.store);

    const second = await (await app.json('/api/admin/products', 'POST', newProduct({ name: 'Camisa Línea Ñandú' }))).json();
    assert.equal(second.id, 'camisa-linea-nandu-2');

    const checkout = await postJson(app.baseUrl, '/api/checkout', {
      items: [{ id: created.id, qty: 1, size: 'S', color: 'Azul' }],
      buyer: BUYER,
      delivery: { method: 'retiro' },
    });
    assert.equal(checkout.status, 200);
  });
});

test('crear producto: valida cada campo y no escribe nada si falla', async () => {
  await withPanel(async (app) => {
    const before = fs.readFileSync(app.fixture.catalogPath, 'utf8');
    const cases = [
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(121) }, 'name'],
      [{ name: 5 }, 'name'],
      [{ category: 'no-existe' }, 'category'],
      [{ price: 0 }, 'price'],
      [{ price: 10.5 }, 'price'],
      [{ price: '9000' }, 'price'],
      [{ price: 50_000_001 }, 'price'],
      [{ description: 'x'.repeat(1001) }, 'description'],
      [{ colors: 'Azul' }, 'colors'],
      [{ colors: [5] }, 'colors'],
      [{ sizes: Array.from({ length: 21 }, (_, i) => `T${i}`) }, 'sizes'],
      [{ sizes: ['x'.repeat(41)] }, 'sizes'],
      [{ featured: 'si' }, 'featured'],
      [{ inStock: 1 }, 'inStock'],
      [{ images: 'img/a.webp' }, 'images'],
      [{ images: ['../../server/.env'] }, 'images'],
      [{ images: ['img/../x.webp'] }, 'images'],
      [{ images: ['http://evil.example/x.jpg'] }, 'images'],
      [{ images: ['uploads/00000000000000000000000000000000.jpg'] }, 'images'],
      [{ images: Array.from({ length: 9 }, (_, i) => `img/${i}.webp`) }, 'images'],
    ];
    for (const [patch, field] of cases) {
      const res = await app.json('/api/admin/products', 'POST', newProduct(patch));
      assert.equal(res.status, 400, JSON.stringify(patch));
      const body = await res.json();
      assert.equal(body.code, 'dato_invalido');
      assert.equal(body.field, field, JSON.stringify(patch));
    }
    assert.equal((await app.json('/api/admin/products', 'POST', [1, 2])).status, 400);
    assert.equal(fs.readFileSync(app.fixture.catalogPath, 'utf8'), before);
  });
});

test('editar producto: cambia precio y datos, conserva id y campos que el panel no maneja', async () => {
  await withPanel(async (app) => {
    const res = await app.json('/api/admin/products/remera', 'PUT', newProduct({ name: 'Remera Renovada', category: 'remeras', price: 45000, colors: [' Blanco ', 'blanco', 'Rojo'] }));
    assert.equal(res.status, 200);
    const product = readCatalog(app).products[0];
    assert.equal(product.id, 'remera');
    assert.equal(product.slug, 'remera-abc');
    assert.equal(product.price, 45000);
    assert.deepEqual(product.colors, ['Blanco', 'Rojo']);
    assert.equal(product.colorCount, 2);

    // el checkout toma el precio nuevo sin reiniciar
    const checkout = await postJson(app.baseUrl, '/api/checkout', {
      items: [{ id: 'remera', qty: 1, size: 'S', color: 'Rojo' }],
      buyer: BUYER,
      delivery: { method: 'retiro' },
    });
    assert.equal(checkout.status, 200);
    const preference = app.mp.calls.find((c) => c.url.endsWith('/checkout/preferences')).body;
    assert.equal(preference.items[0].unit_price, 45000);
  });
});

test('editar producto: sin colores se conserva colorCount; inexistente -> 404', async () => {
  await withPanel(async (app) => {
    const res = await app.json('/api/admin/products/remera', 'PUT', newProduct({ category: 'remeras', colors: [], colorCount: 4 }));
    assert.equal(res.status, 200);
    assert.equal(readCatalog(app).products[0].colorCount, 4);
    assert.equal((await app.json('/api/admin/products/fantasma', 'PUT', newProduct())).status, 404);
    assert.equal((await app.authed('/api/admin/products/fantasma', { method: 'DELETE' })).status, 404);
  });
});

test('eliminar producto: sale del catálogo y el checkout deja de venderlo', async () => {
  await withPanel(async (app) => {
    const res = await app.authed('/api/admin/products/remera', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(readCatalog(app).products, []);
    const checkout = await postJson(app.baseUrl, '/api/checkout', {
      items: [{ id: 'remera', qty: 1 }],
      buyer: BUYER,
      delivery: { method: 'retiro' },
    });
    assert.equal((await checkout.json()).code, 'producto_inexistente');
  });
});

test('ediciones simultáneas no se pisan', async () => {
  await withPanel(async (app) => {
    const names = Array.from({ length: 8 }, (_, i) => `Prenda ${i}`);
    const results = await Promise.all(names.map((name) => app.json('/api/admin/products', 'POST', newProduct({ name }))));
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(readCatalog(app).products.length, 1 + names.length);
  });
});

test('slugify', () => {
  assert.equal(slugify('Chaleco Málaga'), 'chaleco-malaga');
  assert.equal(slugify('  ¡¡Súper  oferta!!  '), 'super-oferta');
  assert.equal(slugify('###'), 'producto');
});

// ---------------------------------------------------------------- imagenes

const upload = (app, body, type) => app.authed('/api/admin/images', { method: 'POST', headers: { 'Content-Type': type }, body });

test('subir imagen: valida los bytes, la sirve con cache largo y se puede usar en un producto', async () => {
  await withPanel(async (app) => {
    const res = await upload(app, JPEG, 'image/jpeg');
    assert.equal(res.status, 201);
    const { url } = await res.json();
    assert.match(url, /^uploads\/[a-f0-9]{32}\.jpg$/);
    const served = await fetch(`${app.baseUrl}/${url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    assert.match(served.headers.get('cache-control'), /max-age=31536000.*immutable/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');

    const png = await (await upload(app, PNG, 'image/png')).json();
    assert.match(png.url, /\.png$/);

    const created = await app.json('/api/admin/products', 'POST', newProduct({ images: [url, 'img/a.webp'] }));
    assert.equal(created.status, 201);
  });
});

test('subir imagen: rechaza archivos que no son imagen aunque digan serlo, y otros tipos', async () => {
  await withPanel(async (app) => {
    assert.equal((await upload(app, Buffer.from('<script>alert(1)</script>'.padEnd(40)), 'image/jpeg')).status, 400);
    assert.equal((await upload(app, Buffer.alloc(0), 'image/png')).status, 400);
    assert.equal((await upload(app, JPEG, 'image/gif')).status, 415);
    assert.equal((await upload(app, JPEG, 'text/html')).status, 415);
    const big = await upload(app, Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]), 'image/jpeg');
    assert.equal(big.status, 413);
    const noAuth = await fetch(`${app.baseUrl}/api/admin/images`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
    assert.equal(noAuth.status, 401);
    assert.deepEqual(fs.existsSync(path.join(app.fixture.dataDir, 'uploads')) ? fs.readdirSync(path.join(app.fixture.dataDir, 'uploads')) : [], []);
  });
});

test('al sacar una imagen subida de su único producto, el archivo se borra; si otro la usa, queda', async () => {
  await withPanel(async (app) => {
    const { url } = await (await upload(app, JPEG, 'image/jpeg')).json();
    const file = path.join(app.fixture.dataDir, url);
    const a = await (await app.json('/api/admin/products', 'POST', newProduct({ name: 'A', images: [url] }))).json();
    const b = await (await app.json('/api/admin/products', 'POST', newProduct({ name: 'B', images: [url] }))).json();
    await app.json(`/api/admin/products/${a.id}`, 'PUT', newProduct({ name: 'A', images: [] }));
    assert.ok(fs.existsSync(file), 'B todavía la usa');
    await app.authed(`/api/admin/products/${b.id}`, { method: 'DELETE' });
    assert.ok(!fs.existsSync(file));
    assert.equal((await fetch(`${app.baseUrl}/${url}`)).status, 404);
  });
});

test('/uploads solo sirve archivos con nombre generado por el panel', async () => {
  await withPanel(async (app) => {
    fs.mkdirSync(path.join(app.fixture.dataDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(app.fixture.dataDir, 'uploads', 'secreto.txt'), 'CANARY');
    fs.writeFileSync(path.join(app.fixture.dataDir, 'orders.jsonl'), 'CANARY');
    for (const route of ['/uploads/secreto.txt', '/uploads/', '/uploads', '/uploads/..%2forders.jsonl', '/uploads/%2e%2e/orders.jsonl', '/uploads/../orders.jsonl']) {
      const res = await rawGet(app.port, route);
      assert.notEqual(res.status, 200, route);
      assert.ok(!res.body.includes('CANARY'), route);
    }
  });
});

// ---------------------------------------------------------------- sitio

test('admin.html se sirve con noindex; admin.js y admin.css solo si existen', async () => {
  await withPanel(async (app) => {
    const res = await fetch(`${app.baseUrl}/admin.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
    assert.equal((await fetch(`${app.baseUrl}/admin.js`)).status, 404); // no está en el fixture
  });
});

// ---------------------------------------------------------------- metricas

const visit = (extra = {}) => ({ tipo: 'visita', visitanteId: 'v_a1', origen: 'instagram', dispositivo: 'm', ...extra });

test('POST /api/metrics: guarda eventos válidos sin login y rechaza el resto', async () => {
  await withPanel(async (app) => {
    assert.equal((await postJson(app.baseUrl, '/api/metrics', visit())).status, 201);
    assert.equal((await postJson(app.baseUrl, '/api/metrics', { tipo: 'abrir_producto', visitanteId: 'v_a1', productoId: 'remera' })).status, 201);
    for (const bad of [
      { tipo: 'hackear' },
      { tipo: 'abrir_producto' }, // falta el producto
      { tipo: 'abrir_producto', productoId: '../../etc/passwd' },
      { tipo: 'visita', visitanteId: 'x'.repeat(200) },
      JSON.stringify('texto'),
      [1],
    ]) {
      const res = await postJson(app.baseUrl, '/api/metrics', bad);
      assert.ok([400, 201].includes(res.status));
      if (res.status === 400) assert.match((await res.json()).code, /^(evento_invalido|json_invalido)$/);
    }
    const lines = fs.readFileSync(path.join(app.fixture.dataDir, 'metrics.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // visitante inválido: el evento se guarda sin identificador; los demás malos no se guardan
    assert.equal(lines.filter((l) => l.tipo === 'visita').length, 2);
    assert.ok(lines.every((l) => !('visitanteId' in l) && !('ip' in l)));
    assert.ok(!JSON.stringify(lines).includes('passwd'));
    assert.ok(lines.filter((l) => l.v).every((l) => /^[\w.-]{1,64}$/.test(l.v)));
  });
});

test('POST /api/metrics: limita ráfagas por IP', async () => {
  await withPanel(async (app) => {
    let last;
    for (let i = 0; i < 125; i += 1) last = await postJson(app.baseUrl, '/api/metrics', visit());
    assert.equal(last.status, 429);
  });
});

test('GET /api/admin/metrics: exige login y resume visitas, embudo, productos y ventas', async () => {
  await withPanel(async (app) => {
    assert.equal((await fetch(`${app.baseUrl}/api/admin/metrics`)).status, 401);
    const send = (body) => postJson(app.baseUrl, '/api/metrics', body);
    await send(visit());
    await send(visit({ visitanteId: 'v_b2', origen: undefined, dispositivo: 'd' }));
    await send({ tipo: 'abrir_producto', visitanteId: 'v_a1', productoId: 'remera' });
    await send({ tipo: 'agregar_carrito', visitanteId: 'v_a1', productoId: 'remera' });
    await send({ tipo: 'iniciar_checkout', visitanteId: 'v_a1' });
    await send({ tipo: 'click_whatsapp', visitanteId: 'v_b2' });
    fs.writeFileSync(path.join(app.fixture.dataDir, 'orders.jsonl'), `${JSON.stringify({
      orderId: 'o1', paymentId: '1', amount: 60000, amountMatches: true, recordedAt: new Date().toISOString(),
      items: [{ id: 'remera', qty: 2, unitPrice: 30000 }], buyer: { name: 'Zulema Quispe', email: 'zulema@example.org' },
    })}\n`);

    const res = await app.authed('/api/admin/metrics');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('Zulema') && !text.includes('zulema@'), 'el resumen no expone datos del comprador');
    const m = JSON.parse(text);
    assert.deepEqual(m.traffic, { visits: 2, unique: 2, new: 2, returning: 0 });
    assert.deepEqual(m.funnel, { visited: 2, openedProduct: 1, addedToCart: 1, startedCheckout: 1, paidOrders: 1 });
    assert.deepEqual(m.sales, { orders: 1, total: 60000, mismatched: 0 });
    assert.equal(m.whatsapp, 1);
    assert.equal(m.daily.length, 14);
    assert.equal(m.daily.at(-1).visits, 2);
    assert.deepEqual(m.products[0], { id: 'remera', name: 'Remera', opened: 1, carted: 1, sold: 2 });
    assert.deepEqual(m.sources.map((s) => s.id).sort(), ['directo', 'instagram']);
  });
});

test('summarize: ventana de 30 días, nuevos vs recurrentes y días sin visitas', () => {
  const now = Date.parse('2026-11-12T15:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const events = [
    { t: now - 40 * day, tipo: 'visita', v: 'viejo' }, // antes de la ventana: hace que 'viejo' sea recurrente
    { t: now - 2 * day, tipo: 'visita', v: 'viejo' },
    { t: now - 1 * day, tipo: 'visita', v: 'nuevo' },
    { t: now - 45 * day, tipo: 'abrir_producto', v: 'viejo', id: 'remera' }, // fuera de la ventana
  ];
  const orders = [
    { recordedAt: new Date(now - day).toISOString(), amount: 100.5, amountMatches: false, items: [{ id: 'x', qty: 1 }] },
    { recordedAt: new Date(now - 60 * day).toISOString(), amount: 999, items: [] },
  ];
  const m = summarize({ events, orders, productNames: new Map(), now });
  assert.deepEqual(m.traffic, { visits: 2, unique: 2, new: 1, returning: 1 });
  assert.equal(m.sales.orders, 1);
  assert.equal(m.sales.total, 100.5);
  assert.equal(m.sales.mismatched, 1);
  assert.equal(m.products.length, 1);
  assert.equal(m.products[0].name, null);
  assert.equal(m.daily.filter((d) => d.visits === 0).length, 12);
  assert.equal(m.funnel.openedProduct, 0);
});

test('normalizeEvent: solo guarda los campos conocidos', () => {
  const e = normalizeEvent({ tipo: 'visita', visitanteId: 'v_1', origen: 'Instagram.com', dispositivo: 'd', ip: '1.2.3.4', email: 'a@b.c' }, 123);
  assert.deepEqual(e, { t: 123, tipo: 'visita', v: 'v_1', o: 'instagram.com', d: 'd' });
  assert.equal(normalizeEvent({ tipo: 'agregar_carrito', productoId: 'a b' }), null);
  assert.equal(normalizeEvent(null), null);
});

// ---------------------------------------------------------------- catalogo en el volumen de datos

test('/catalog.json se sirve desde catalogPath aunque esté fuera de la raíz, y el panel lo edita ahí', async () => {
  const fixture = fixtureWithCatalog();
  const moved = path.join(fixture.dataDir, 'catalog.json');
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  fs.renameSync(fixture.catalogPath, moved);
  fixture.catalogPath = moved;
  const app = await startApp({ env: ENV, fixture });
  try {
    const served = await (await fetch(`${app.baseUrl}/catalog.json`)).json();
    assert.deepEqual(served.categories, CATALOG.categories);
    const { token } = await (await postJson(app.baseUrl, '/api/login', { usuario: 'clotta', password: PASSWORD })).json();
    const res = await fetch(`${app.baseUrl}/api/admin/products/remera`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(newProduct({ name: 'Remera', category: 'remeras', price: 77000 })),
    });
    assert.equal(res.status, 200);
    assert.equal((await (await fetch(`${app.baseUrl}/catalog.json`)).json()).products[0].price, 77000);
    assert.equal(fs.existsSync(path.join(fixture.root, 'catalog.json')), false);
  } finally {
    await app.close();
  }
});
