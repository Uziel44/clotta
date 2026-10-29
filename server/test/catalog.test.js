'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { CatalogError, createCatalogLoader } = require('../lib/catalog');
const { buildOrder } = require('../lib/pricing');

const REAL_CATALOG = path.resolve(__dirname, '..', '..', 'catalog.json');

test('el catalog.json real es válido y se puede cobrar cada producto', () => {
  const catalog = createCatalogLoader(REAL_CATALOG)();
  assert.ok(catalog.products.size > 0);
  for (const product of catalog.products.values()) {
    assert.ok(Number.isInteger(product.price) && product.price > 0, `${product.id}: precio entero > 0`);
    for (const key of ['sizes', 'colors']) {
      assert.ok(product[key] === undefined || Array.isArray(product[key]), `${product.id}.${key} es array`);
    }
    if (product.inStock === false) continue;
    const item = { id: product.id, qty: 1, size: product.sizes?.[0], color: product.colors?.[0] };
    const order = buildOrder(catalog, [item]);
    assert.equal(order.total, product.price);
  }
});

test('las imágenes que referencia el catálogo real existen (solo las que el server va a servir)', () => {
  const catalog = createCatalogLoader(REAL_CATALOG)();
  const root = path.dirname(REAL_CATALOG);
  const missing = [];
  for (const product of catalog.products.values()) {
    for (const image of product.images ?? []) {
      if (!fs.existsSync(path.join(root, image))) missing.push(`${product.id}: ${image}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('el loader relee al cambiar el archivo y conserva la última versión válida si queda roto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clotta-catalog-'));
  const file = path.join(dir, 'catalog.json');
  const errors = [];
  try {
    const write = (content, bump) => {
      fs.writeFileSync(file, content);
      const when = new Date(Date.now() + bump * 1000);
      fs.utimesSync(file, when, when);
    };
    write(JSON.stringify({ products: [{ id: 'a', name: 'A', price: 100 }] }), 1);
    const get = createCatalogLoader(file, { error: (msg) => errors.push(msg) });
    assert.equal(get().products.get('a').price, 100);

    write(JSON.stringify({ products: [{ id: 'a', name: 'A', price: 250 }] }), 2);
    assert.equal(get().products.get('a').price, 250, 'precio editado sin reiniciar');

    write('{ guardado a medias', 3);
    assert.equal(get().products.get('a').price, 250, 'sigue la última versión válida');
    assert.deepEqual(errors, ['catalog.reload_failed']);
    get();
    assert.equal(errors.length, 1, 'no repite el log mientras el archivo no cambie');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catálogo ilegible desde el arranque -> CatalogError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clotta-catalog-'));
  try {
    assert.throws(() => createCatalogLoader(path.join(dir, 'no-existe.json'))(), CatalogError);
    const file = path.join(dir, 'roto.json');
    fs.writeFileSync(file, 'no es json');
    assert.throws(() => createCatalogLoader(file)(), CatalogError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
