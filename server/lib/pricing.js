'use strict';

const { CatalogError } = require('./catalog');

const MAX_LINES = 20;
const MAX_QTY = 10;
const MAX_VARIANT_LENGTH = 40;

class CheckoutError extends Error {
  constructor(code, message, status = 400, field = null) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

function listOf(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v !== '') : [];
}

// Si el producto define opciones, la elegida debe estar en la lista. Si no define
// ninguna, el valor que mande el cliente se ignora (carrito viejo, talle unico).
function resolveVariant(options, picked, code, label, productName) {
  if (options.length === 0) return null;
  if (typeof picked !== 'string' || picked.length > MAX_VARIANT_LENGTH || !options.includes(picked)) {
    throw new CheckoutError(code, `${label} inválido para "${productName}". Opciones: ${options.join(', ')}.`);
  }
  return picked;
}

function unitPriceOf(product) {
  if (!Number.isInteger(product.price) || product.price <= 0) {
    throw new CatalogError(`precio invalido para "${product.id}"`);
  }
  return product.price;
}

// Arma las lineas del pedido SOLO con datos del catalogo; del cliente toma
// unicamente id, qty, size y color. Devuelve enteros en la moneda del catalogo.
function buildOrder(catalog, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new CheckoutError('items_vacios', 'El carrito está vacío.');
  }
  if (rawItems.length > MAX_LINES) {
    throw new CheckoutError('demasiados_items', `El carrito admite hasta ${MAX_LINES} líneas.`);
  }

  const merged = new Map();
  for (const raw of rawItems) {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const product = typeof item.id === 'string' ? catalog.products.get(item.id) : undefined;
    if (!product) {
      throw new CheckoutError('producto_inexistente', 'Hay un producto que ya no está disponible.');
    }
    if (product.inStock === false) {
      throw new CheckoutError('sin_stock', `"${product.name}" no tiene stock.`);
    }
    if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_QTY) {
      throw new CheckoutError('cantidad_invalida', `La cantidad de "${product.name}" debe ser un entero entre 1 y ${MAX_QTY}.`);
    }
    const size = resolveVariant(listOf(product.sizes), item.size, 'talle_invalido', 'Talle', product.name);
    const color = resolveVariant(listOf(product.colors), item.color, 'color_invalido', 'Color', product.name);

    const key = `${product.id}|${size ?? ''}|${color ?? ''}`;
    const line = merged.get(key);
    if (line) {
      line.qty += item.qty;
    } else {
      merged.set(key, { id: product.id, name: product.name, qty: item.qty, size, color, unitPrice: unitPriceOf(product), product });
    }
  }

  const lines = [];
  let total = 0;
  for (const line of merged.values()) {
    if (line.qty > MAX_QTY) {
      throw new CheckoutError('cantidad_invalida', `La cantidad de "${line.name}" debe ser un entero entre 1 y ${MAX_QTY}.`);
    }
    const { product, ...rest } = line;
    const title = [rest.name, rest.size && `Talle ${rest.size}`, rest.color].filter(Boolean).join(' · ').slice(0, 250);
    lines.push({ ...rest, title, image: listOf(product.images)[0] ?? null });
    total += rest.unitPrice * rest.qty;
  }

  const currency = /^[A-Z]{3}$/.test(catalog.store.currency ?? '') ? catalog.store.currency : 'ARS';
  return { lines, total, currency };
}

// --- Comprador y entrega -------------------------------------------------------
// Datos personales: los mensajes de error nombran el campo, nunca repiten el valor.

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PHONE_RE = /^[0-9+()\-\s]{8,20}$/;
const ZIP_RE = /^[A-Za-z0-9 -]{3,10}$/;
const STREET_NUMBER_RE = /^[A-Za-z0-9./\- ]{1,10}$/;
// Sin HTML ni caracteres de control.
const UNSAFE_TEXT_RE = /[<>\u0000-\u001f\u007f]/;

function fail(code, field, message) {
  throw new CheckoutError(code, message, 400, field);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Texto de una linea, con espacios colapsados y largo acotado; null si no sirve.
function readText(value, min, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < min || text.length > max || UNSAFE_TEXT_RE.test(text)) return null;
  return text;
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function validateBuyer(raw) {
  if (!isPlainObject(raw)) fail('buyer_invalido', 'buyer', 'Faltan los datos del comprador.');
  const name = readText(raw.name, 2, 80)
    ?? fail('buyer_invalido', 'buyer.name', 'El nombre debe tener entre 2 y 80 caracteres y no puede incluir < o >.');

  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  if (email.length > 120 || !EMAIL_RE.test(email)) {
    fail('buyer_invalido', 'buyer.email', 'El email no es válido.');
  }

  const phone = typeof raw.phone === 'string' ? raw.phone.trim() : '';
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 6) {
    fail('buyer_invalido', 'buyer.phone', 'El teléfono debe tener entre 8 y 20 caracteres (solo números, espacios, +, -, paréntesis).');
  }
  return { name, email, phone };
}

function validateAddress(raw) {
  if (!isPlainObject(raw)) fail('direccion_invalida', 'delivery.address', 'Falta la dirección de envío.');
  const street = readText(raw.street, 2, 100)
    ?? fail('direccion_invalida', 'delivery.address.street', 'La calle debe tener entre 2 y 100 caracteres.');
  const city = readText(raw.city, 2, 80)
    ?? fail('direccion_invalida', 'delivery.address.city', 'La localidad debe tener entre 2 y 80 caracteres.');
  const province = readText(raw.province, 2, 80)
    ?? fail('direccion_invalida', 'delivery.address.province', 'La provincia debe tener entre 2 y 80 caracteres.');
  const zip = readText(raw.zip, 3, 10);
  if (!zip || !ZIP_RE.test(zip)) fail('direccion_invalida', 'delivery.address.zip', 'El código postal no es válido.');

  const address = { street, city, province, zip };
  if (!isBlank(raw.number)) {
    const number = Number.isInteger(raw.number) && raw.number > 0 ? String(raw.number) : readText(raw.number, 1, 10);
    if (!number || !STREET_NUMBER_RE.test(number)) {
      fail('direccion_invalida', 'delivery.address.number', 'El número de calle no es válido.');
    }
    address.number = number;
  }
  return address;
}

// 'retiro' ignora address por completo (ni se valida ni se guarda).
function validateDelivery(raw) {
  if (!isPlainObject(raw)) fail('entrega_invalida', 'delivery', 'Elegí cómo querés recibir tu pedido.');
  if (raw.method !== 'retiro' && raw.method !== 'envio') {
    fail('entrega_invalida', 'delivery.method', 'El método de entrega debe ser "retiro" o "envio".');
  }
  const delivery = { method: raw.method };
  if (raw.method === 'envio') delivery.address = validateAddress(raw.address);
  if (!isBlank(raw.notes)) {
    const notes = readText(raw.notes, 1, 200)
      ?? fail('entrega_invalida', 'delivery.notes', 'Las notas admiten hasta 200 caracteres y no pueden incluir < o >.');
    delivery.notes = notes;
  }
  return delivery;
}

// Valores personales de un pedido, para sacarlos de textos de terceros antes de loguearlos.
function collectPii(buyer, delivery) {
  const digits = buyer?.phone?.replace(/\D/g, '');
  // Mercado Pago recibe el telefono solo con digitos; el numero local puede volver sin el 54.
  const values = [buyer?.name, buyer?.email, buyer?.phone, digits, digits?.slice(-10)];
  if (delivery) {
    const { street, number, city, province, zip } = delivery.address ?? {};
    values.push(street, number, city, province, zip, delivery.notes);
  }
  return values.filter((value) => typeof value === 'string' && value.length >= 3).sort((a, b) => b.length - a.length);
}

function scrubValues(text, values) {
  if (typeof text !== 'string') return text;
  return values.reduce((out, value) => out.split(value).join('[redacted]'), text);
}

module.exports = {
  MAX_LINES,
  MAX_QTY,
  CheckoutError,
  buildOrder,
  validateBuyer,
  validateDelivery,
  collectPii,
  scrubValues,
};
