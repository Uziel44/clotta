'use strict';

const fs = require('node:fs');

class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogError';
  }
}

function parseCatalog(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !Array.isArray(data.products)) {
    throw new CatalogError('catalog.json: falta products[]');
  }
  const products = new Map();
  for (const product of data.products) {
    if (!product || typeof product.id !== 'string' || product.id === '') {
      throw new CatalogError('catalog.json: producto sin id');
    }
    if (products.has(product.id)) {
      throw new CatalogError(`catalog.json: id duplicado "${product.id}"`);
    }
    products.set(product.id, product);
  }
  const store = data.store && typeof data.store === 'object' ? data.store : {};
  return { store, products };
}

// catalog.json es la unica fuente de precios. Se relee cuando cambia mtime/size,
// asi editar un precio no obliga a reiniciar. Si una edicion deja el archivo roto
// (guardado a medias), se sigue sirviendo la ultima version valida.
function createCatalogLoader(filePath, log = {}) {
  let cached = null;
  let stamp = '';

  return function getCatalog() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (cached) return cached;
      throw new CatalogError('no se pudo leer catalog.json');
    }
    const nextStamp = `${stat.mtimeMs}:${stat.size}`;
    if (cached && nextStamp === stamp) return cached;
    try {
      cached = parseCatalog(fs.readFileSync(filePath, 'utf8'));
      stamp = nextStamp;
    } catch (err) {
      if (!cached) throw err instanceof CatalogError ? err : new CatalogError('catalog.json invalido');
      stamp = nextStamp;
      log.error?.('catalog.reload_failed', { reason: err.message });
    }
    return cached;
  };
}

// En produccion el catalogo vive en el volumen de datos y el panel solo edita "products". El resto
// (tienda, categorias, textos y videos de la portada) lo manda el repo: en cada arranque se copia del
// catalog.json que trae la imagen, sin tocar los productos. Devuelve true si hubo cambios.
function syncRepoSections(seedPath, livePath) {
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  const next = { ...live };
  for (const key of Object.keys(seed)) {
    if (key !== 'products') next[key] = seed[key];
  }
  if (JSON.stringify(next) === JSON.stringify(live)) return false;
  const tmp = `${livePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`);
  fs.renameSync(tmp, livePath);
  return true;
}

module.exports = { CatalogError, parseCatalog, createCatalogLoader, syncRepoSections };
