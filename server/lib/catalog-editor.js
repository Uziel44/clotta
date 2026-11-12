'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class AdminError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const invalid = (message, field) => new AdminError(400, 'dato_invalido', message, field);

const MAX_PRICE = 50_000_000;
const MAX_IMAGES = 8;
// Imagenes del repo (img/) o subidas desde el panel (uploads/, nombre aleatorio).
const STATIC_IMAGE = /^img\/[\w.-]{1,160}\.(?:webp|jpe?g|png|avif)$/i;
const UPLOADED_IMAGE = /^uploads\/[a-f0-9]{32}\.(?:jpg|png|webp)$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function slugify(text) {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'producto';
}

// Tipo real segun los primeros bytes: el Content-Type que manda el cliente no es de fiar.
function imageExtension(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function cleanList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw invalid(`${label}: enviá una lista de hasta 20 valores.`, label);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') throw invalid(`${label}: cada valor debe ser texto.`, label);
    const text = item.trim();
    if (!text) continue;
    if (text.length > 40) throw invalid(`${label}: cada valor puede tener hasta 40 caracteres.`, label);
    if (!out.some((other) => other.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
}

function flag(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${label} debe ser verdadero o falso.`, label);
  return value;
}

// Edita catalog.json (la fuente de precios del checkout). Cada cambio relee el archivo, lo modifica
// y lo reemplaza de forma atomica; las operaciones corren de a una. createCatalogLoader detecta el
// cambio por mtime, asi que la web y el checkout lo ven al instante.
function createCatalogEditor({ catalogPath, uploadsDir }) {
  let chain = Promise.resolve();
  const locked = (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };

  const read = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const write = (data) => {
    const tmp = `${catalogPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, catalogPath);
  };

  function validateImages(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_IMAGES) throw invalid(`Hasta ${MAX_IMAGES} imágenes por producto.`, 'images');
    const out = [];
    for (const image of value) {
      if (typeof image !== 'string') throw invalid('La ruta de una imagen no es válida.', 'images');
      if (STATIC_IMAGE.test(image)) {
        out.push(image);
      } else if (UPLOADED_IMAGE.test(image)) {
        if (!fs.existsSync(path.join(uploadsDir, path.basename(image)))) {
          throw invalid('Una imagen subida ya no existe en el servidor. Subila de nuevo.', 'images');
        }
        out.push(image);
      } else {
        throw invalid('La ruta de una imagen no es válida.', 'images');
      }
    }
    return [...new Set(out)];
  }

  function validateProduct(body, categories, existing) {
    if (!isObject(body)) throw invalid('El cuerpo debe ser un objeto JSON.');
    if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('El nombre es obligatorio.', 'name');
    const name = body.name.trim();
    if (name.length > 120) throw invalid('El nombre puede tener hasta 120 caracteres.', 'name');
    if (typeof body.category !== 'string' || !categories.some((c) => c.id === body.category)) {
      throw invalid('Elegí una categoría de la lista.', 'category');
    }
    if (!Number.isInteger(body.price) || body.price < 1 || body.price > MAX_PRICE) {
      throw invalid('El precio debe ser un número entero en pesos, mayor a 0.', 'price');
    }
    const description = body.description === undefined || body.description === null ? '' : body.description;
    if (typeof description !== 'string' || description.length > 1000) {
      throw invalid('La descripción puede tener hasta 1000 caracteres.', 'description');
    }
    const colors = cleanList(body.colors, 'colors');
    const sizes = cleanList(body.sizes, 'sizes');
    let colorCount = colors.length;
    if (!colorCount) {
      const raw = body.colorCount ?? existing?.colorCount ?? 0;
      if (!Number.isInteger(raw) || raw < 0 || raw > 50) throw invalid('La cantidad de colores debe ser un número entre 0 y 50.', 'colorCount');
      colorCount = raw;
    }
    return {
      name,
      category: body.category,
      price: body.price,
      colorCount,
      colors,
      sizes,
      featured: flag(body.featured, existing?.featured ?? false, 'featured'),
      inStock: flag(body.inStock, existing?.inStock ?? true, 'inStock'),
      description: description.trim(),
      images: validateImages(body.images),
    };
  }

  // Borra de uploads/ las imagenes que ya ningun producto usa.
  function dropUnusedUploads(candidates, products) {
    const inUse = new Set(products.flatMap((p) => p.images ?? []));
    for (const image of candidates) {
      if (UPLOADED_IMAGE.test(image) && !inUse.has(image)) fs.rmSync(path.join(uploadsDir, path.basename(image)), { force: true });
    }
  }

  function uniqueId(name, products) {
    const base = slugify(name);
    let id = base;
    for (let n = 2; products.some((p) => p.id === id); n += 1) id = `${base}-${n}`;
    return id;
  }

  return {
    view: () => {
      const { categories = [], products = [], store = {} } = read();
      return { categories, products, transferDiscount: store.transferDiscount ?? 0 };
    },

    create: (body) =>
      locked(() => {
        const data = read();
        const fields = validateProduct(body, data.categories ?? [], null);
        const product = { id: uniqueId(fields.name, data.products), ...fields };
        data.products.push(product);
        write(data);
        return product;
      }),

    update: (id, body) =>
      locked(() => {
        const data = read();
        const product = data.products.find((p) => p.id === id);
        if (!product) throw new AdminError(404, 'no_encontrado', 'Ese producto ya no existe.');
        const previousImages = product.images ?? [];
        Object.assign(product, validateProduct(body, data.categories ?? [], product));
        write(data);
        dropUnusedUploads(previousImages, data.products);
        return product;
      }),

    remove: (id) =>
      locked(() => {
        const data = read();
        const index = data.products.findIndex((p) => p.id === id);
        if (index < 0) throw new AdminError(404, 'no_encontrado', 'Ese producto ya no existe.');
        const [removed] = data.products.splice(index, 1);
        write(data);
        dropUnusedUploads(removed.images ?? [], data.products);
      }),

    async saveImage(buffer) {
      const ext = Buffer.isBuffer(buffer) && buffer.length ? imageExtension(buffer) : null;
      if (!ext) throw invalid('El archivo no es una imagen JPG, PNG o WebP válida.');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      await fs.promises.writeFile(path.join(uploadsDir, file), buffer, { flag: 'wx' });
      return `uploads/${file}`;
    },
  };
}

module.exports = { AdminError, createCatalogEditor, imageExtension, slugify };
