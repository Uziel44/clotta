'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCatalog, CatalogError } = require('../lib/catalog');
const {
  buildOrder,
  collectPii,
  scrubValues,
  validateBuyer,
  validateDelivery,
  CheckoutError,
} = require('../lib/pricing');
const { FIXTURE_CATALOG } = require('./helpers');

const catalog = parseCatalog(JSON.stringify(FIXTURE_CATALOG));

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CheckoutError, `se esperaba CheckoutError, llegó ${err}`);
    return err.code;
  }
  return null;
}

test('items vacíos o con forma inválida -> items_vacios', () => {
  for (const items of [undefined, null, [], 'remera', {}]) {
    assert.equal(codeOf(() => buildOrder(catalog, items)), 'items_vacios');
  }
});

test('más de 20 líneas -> demasiados_items', () => {
  const variants = [
    { id: 'remera' },
    { id: 'barato' },
    { id: 'jean', size: 'S', color: 'Azul' },
    { id: 'jean', size: 'S', color: 'Negro' },
    { id: 'jean', size: 'M', color: 'Azul' },
    { id: 'jean', size: 'M', color: 'Negro' },
  ];
  const items = Array.from({ length: 21 }, (_, i) => ({ ...variants[i % variants.length], qty: 1 }));
  assert.equal(codeOf(() => buildOrder(catalog, items)), 'demasiados_items');
  const order = buildOrder(catalog, items.slice(0, 20));
  assert.equal(order.lines.length, variants.length, 'las líneas repetidas se fusionan');
  assert.equal(order.lines.reduce((sum, line) => sum + line.qty, 0), 20);
});

test('producto inexistente, id no string, línea no objeto y ids de prototipo', () => {
  for (const item of [{ id: 'nada', qty: 1 }, { id: 5, qty: 1 }, { qty: 1 }, null, 'remera', { id: '__proto__', qty: 1 }, { id: 'constructor', qty: 1 }, { id: 'toString', qty: 1 }]) {
    assert.equal(codeOf(() => buildOrder(catalog, [item])), 'producto_inexistente', JSON.stringify(item));
  }
});

test('inStock:false -> sin_stock', () => {
  assert.equal(codeOf(() => buildOrder(catalog, [{ id: 'agotado', qty: 1 }])), 'sin_stock');
});

test('cantidad fuera de 1..10, decimal o no numérica -> cantidad_invalida', () => {
  for (const qty of [0, -1, 11, 1.5, '2', null, undefined, NaN, Infinity]) {
    assert.equal(codeOf(() => buildOrder(catalog, [{ id: 'remera', qty }])), 'cantidad_invalida', String(qty));
  }
  assert.equal(buildOrder(catalog, [{ id: 'remera', qty: 10 }]).total, 300000);
});

test('líneas repetidas se suman y el total no puede pasar de 10 por línea', () => {
  const order = buildOrder(catalog, [{ id: 'remera', qty: 2 }, { id: 'remera', qty: 3 }]);
  assert.equal(order.lines.length, 1);
  assert.equal(order.lines[0].qty, 5);
  assert.equal(codeOf(() => buildOrder(catalog, [{ id: 'remera', qty: 6 }, { id: 'remera', qty: 6 }])), 'cantidad_invalida');
});

test('talle obligatorio si el producto lo define y debe estar en la lista -> talle_invalido', () => {
  for (const size of [undefined, null, 'XL', 's', 5, 'S'.repeat(41)]) {
    assert.equal(codeOf(() => buildOrder(catalog, [{ id: 'jean', qty: 1, size, color: 'Azul' }])), 'talle_invalido', String(size));
  }
});

test('color obligatorio si el producto lo define y debe estar en la lista -> color_invalido', () => {
  for (const color of [undefined, 'Rojo', 'azul', 7]) {
    assert.equal(codeOf(() => buildOrder(catalog, [{ id: 'jean', qty: 1, size: 'S', color }])), 'color_invalido', String(color));
  }
});

test('talle/color de más en un producto sin opciones se ignoran', () => {
  const [line] = buildOrder(catalog, [{ id: 'remera', qty: 1, size: 'XXL', color: 'Rojo' }]).lines;
  assert.equal(line.size, null);
  assert.equal(line.color, null);
  assert.equal(line.title, 'Remera');
});

test('el precio sale del catálogo: lo que mande el cliente se ignora', () => {
  const order = buildOrder(catalog, [{ id: 'remera', qty: 2, price: 1, unitPrice: 1, unit_price: 1, total: 1 }]);
  assert.equal(order.lines[0].unitPrice, 30000);
  assert.equal(order.total, 60000);
  assert.equal(order.currency, 'ARS');
});

test('mismo producto con distinto talle/color son líneas distintas, con título descriptivo', () => {
  const order = buildOrder(catalog, [
    { id: 'jean', qty: 1, size: 'S', color: 'Azul' },
    { id: 'jean', qty: 2, size: 'M', color: 'Negro' },
    { id: 'remera', qty: 1 },
  ]);
  assert.equal(order.lines.length, 3);
  assert.equal(order.lines[0].title, 'Jean · Talle S · Azul');
  assert.equal(order.total, 80000 + 160000 + 30000);
  assert.equal(order.lines[2].image, 'img/a.webp');
});

test('precio inválido en el catálogo es un error de catálogo, no se cobra', () => {
  for (const price of [0, -5, 10.5, '100', null]) {
    const broken = parseCatalog(JSON.stringify({ products: [{ id: 'x', name: 'X', price }] }));
    assert.throws(() => buildOrder(broken, [{ id: 'x', qty: 1 }]), CatalogError, String(price));
  }
});

test('parseCatalog rechaza ids duplicados y productos sin id', () => {
  assert.throws(() => parseCatalog(JSON.stringify({ products: [{ id: 'a' }, { id: 'a' }] })), CatalogError);
  assert.throws(() => parseCatalog(JSON.stringify({ products: [{ name: 'x' }] })), CatalogError);
  assert.throws(() => parseCatalog(JSON.stringify({ nada: [] })), CatalogError);
});

// ---------------------------------------------------------------- comprador y entrega

function failureOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CheckoutError, `se esperaba CheckoutError, llegó ${err}`);
    return { code: err.code, field: err.field, status: err.status, message: err.message };
  }
  return null;
}

const validBuyer = { name: ' Ana   Pérez ', email: ' ana@mail.com ', phone: ' +54 (351) 617-6285 ' };

test('validateBuyer: acepta datos válidos y los normaliza (trim, espacios colapsados)', () => {
  assert.deepEqual(validateBuyer(validBuyer), { name: 'Ana Pérez', email: 'ana@mail.com', phone: '+54 (351) 617-6285' });
  assert.equal(validateBuyer({ ...validBuyer, name: 'Al' }).name, 'Al');
  assert.equal(validateBuyer({ ...validBuyer, name: 'x'.repeat(80) }).name.length, 80);
  assert.equal(validateBuyer({ ...validBuyer, phone: '12345678' }).phone, '12345678');
  assert.equal(validateBuyer({ ...validBuyer, email: `${'a'.repeat(111)}@mail.com` }).email.length, 120);
});

test('validateBuyer: cada campo inválido -> buyer_invalido con field', () => {
  const cases = [
    ['buyer', undefined],
    ['buyer', null],
    ['buyer', 'Ana'],
    ['buyer', []],
    ['buyer.name', { ...validBuyer, name: undefined }],
    ['buyer.name', { ...validBuyer, name: 'A' }],
    ['buyer.name', { ...validBuyer, name: '   ' }],
    ['buyer.name', { ...validBuyer, name: 'x'.repeat(81) }],
    ['buyer.name', { ...validBuyer, name: '<b>Ana</b>' }],
    ['buyer.name', { ...validBuyer, name: 'Ana\u0000' }],
    ['buyer.name', { ...validBuyer, name: 42 }],
    ['buyer.email', { ...validBuyer, email: undefined }],
    ['buyer.email', { ...validBuyer, email: 'sin-arroba' }],
    ['buyer.email', { ...validBuyer, email: 'a@b' }],
    ['buyer.email', { ...validBuyer, email: 'a b@mail.com' }],
    ['buyer.email', { ...validBuyer, email: '<a@mail.com>' }],
    ['buyer.email', { ...validBuyer, email: `${'a'.repeat(112)}@mail.com` }],
    ['buyer.phone', { ...validBuyer, phone: undefined }],
    ['buyer.phone', { ...validBuyer, phone: '1234567' }],
    ['buyer.phone', { ...validBuyer, phone: '1'.repeat(21) }],
    ['buyer.phone', { ...validBuyer, phone: '351-abc-6285' }],
    ['buyer.phone', { ...validBuyer, phone: '+++-----()' }],
    ['buyer.phone', { ...validBuyer, phone: 3516176285 }],
  ];
  for (const [field, raw] of cases) {
    const failure = failureOf(() => validateBuyer(raw));
    assert.deepEqual([failure?.code, failure?.field, failure?.status], ['buyer_invalido', field, 400], JSON.stringify(raw));
  }
});

const validAddress = { street: ' Av.  Richieri ', number: '2872', city: 'Córdoba', province: 'Córdoba', zip: '5000' };

test('validateDelivery: retiro e envío válidos', () => {
  assert.deepEqual(validateDelivery({ method: 'retiro' }), { method: 'retiro' });
  assert.deepEqual(validateDelivery({ method: 'envio', address: validAddress, notes: ' Timbre 3 ' }), {
    method: 'envio',
    address: { street: 'Av. Richieri', number: '2872', city: 'Córdoba', province: 'Córdoba', zip: '5000' },
    notes: 'Timbre 3',
  });
  const noNumber = validateDelivery({ method: 'envio', address: { ...validAddress, number: undefined } });
  assert.equal('number' in noNumber.address, false, 'el número es opcional');
  assert.equal(validateDelivery({ method: 'envio', address: { ...validAddress, number: 2872 } }).address.number, '2872');
  assert.equal(validateDelivery({ method: 'envio', address: { ...validAddress, number: 'S/N' } }).address.number, 'S/N');
  assert.equal(validateDelivery({ method: 'envio', address: { ...validAddress, zip: 'X5016ABC' } }).address.zip, 'X5016ABC');
  assert.equal(validateDelivery({ method: 'retiro', notes: 'n'.repeat(200) }).notes.length, 200);
});

test('validateDelivery: retiro ignora address (aunque venga rota) y no la guarda', () => {
  assert.deepEqual(validateDelivery({ method: 'retiro', address: validAddress }), { method: 'retiro' });
  assert.deepEqual(validateDelivery({ method: 'retiro', address: { street: '<x>' } }), { method: 'retiro' });
  assert.deepEqual(validateDelivery({ method: 'retiro', address: 'basura' }), { method: 'retiro' });
});

test('validateDelivery: método inválido o notas inválidas -> entrega_invalida', () => {
  const cases = [
    ['delivery', undefined],
    ['delivery', null],
    ['delivery', 'retiro'],
    ['delivery.method', {}],
    ['delivery.method', { method: 'correo' }],
    ['delivery.method', { method: 'RETIRO' }],
    ['delivery.notes', { method: 'retiro', notes: 'n'.repeat(201) }],
    ['delivery.notes', { method: 'retiro', notes: '<script>alert(1)</script>' }],
    ['delivery.notes', { method: 'retiro', notes: 5 }],
    ['delivery.notes', { method: 'envio', address: validAddress, notes: 'a\u0007b' }],
  ];
  for (const [field, raw] of cases) {
    const failure = failureOf(() => validateDelivery(raw));
    assert.deepEqual([failure?.code, failure?.field, failure?.status], ['entrega_invalida', field, 400], JSON.stringify(raw));
  }
});

test('validateDelivery: envío con dirección incompleta o inválida -> direccion_invalida con field', () => {
  const cases = [
    ['delivery.address', undefined],
    ['delivery.address', null],
    ['delivery.address', 'Av. Richieri 2872'],
    ['delivery.address.street', { ...validAddress, street: undefined }],
    ['delivery.address.street', { ...validAddress, street: 'A' }],
    ['delivery.address.street', { ...validAddress, street: 'x'.repeat(101) }],
    ['delivery.address.street', { ...validAddress, street: '<img src=x onerror=1>' }],
    ['delivery.address.city', { ...validAddress, city: '' }],
    ['delivery.address.city', { ...validAddress, city: 'C' }],
    ['delivery.address.province', { ...validAddress, province: undefined }],
    ['delivery.address.province', { ...validAddress, province: 'x'.repeat(81) }],
    ['delivery.address.zip', { ...validAddress, zip: undefined }],
    ['delivery.address.zip', { ...validAddress, zip: '50' }],
    ['delivery.address.zip', { ...validAddress, zip: '5000-5000-50' }],
    ['delivery.address.zip', { ...validAddress, zip: '50<0' }],
    ['delivery.address.number', { ...validAddress, number: 'x'.repeat(11) }],
    ['delivery.address.number', { ...validAddress, number: '<1>' }],
    ['delivery.address.number', { ...validAddress, number: -4 }],
  ];
  for (const [field, address] of cases) {
    const failure = failureOf(() => validateDelivery({ method: 'envio', address }));
    assert.deepEqual([failure?.code, failure?.field, failure?.status], ['direccion_invalida', field, 400], JSON.stringify(address));
  }
});

test('los mensajes de error nombran el campo pero nunca repiten el valor enviado', () => {
  const secret = 'secreto-personal@mail.com';
  const failure = failureOf(() => validateBuyer({ ...validBuyer, email: `${secret}<` }));
  assert.ok(!failure.message.includes('secreto'));
  const bad = failureOf(() => validateDelivery({ method: 'envio', address: { ...validAddress, street: 'Calle <Privada>' } }));
  assert.ok(!bad.message.includes('Privada'));
});

test('collectPii y scrubValues sacan los datos personales de un texto de terceros', () => {
  const buyer = { name: 'Ana Pérez', email: 'ana@mail.com', phone: '+54 351 617-6285' };
  const delivery = { method: 'envio', address: { street: 'Av. Richieri', number: '28', city: 'Córdoba', province: 'Córdoba', zip: '5000' }, notes: 'Timbre 3' };
  const text = 'invalid payer ana@mail.com phone 543516176285 / +54 351 617-6285 en Av. Richieri, Córdoba (5000) Ana Pérez Timbre 3';
  const clean = scrubValues(text, collectPii(buyer, delivery));
  for (const piece of ['ana@mail.com', '543516176285', '617-6285', 'Richieri', 'Córdoba', '5000', 'Ana Pérez', 'Timbre 3']) {
    assert.ok(!clean.includes(piece), `quedó "${piece}" en: ${clean}`);
  }
  assert.equal(scrubValues(null, ['x']), null);
});
