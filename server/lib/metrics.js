'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EVENT_TYPES = new Set(['visita', 'abrir_producto', 'agregar_carrito', 'iniciar_checkout', 'click_whatsapp']);
const PRODUCT_EVENTS = new Set(['abrir_producto', 'agregar_carrito']);
const ID = /^[\w.-]{1,64}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,119}$/i;

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * DAY_MS;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // tope de seguridad del archivo
const TIME_ZONE = 'America/Argentina/Buenos_Aires'; // los dias se cuentan en hora argentina
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(ms);

// Devuelve el evento listo para guardar o null si no es valido. Solo se guarda un identificador
// aleatorio de navegador (para contar personas distintas): ni IP ni datos personales.
function normalizeEvent(body, now = Date.now()) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !EVENT_TYPES.has(body.tipo)) return null;
  const event = { t: now, tipo: body.tipo };
  if (typeof body.visitanteId === 'string' && ID.test(body.visitanteId)) event.v = body.visitanteId;
  if (PRODUCT_EVENTS.has(body.tipo)) {
    if (typeof body.productoId !== 'string' || !ID.test(body.productoId)) return null;
    event.id = body.productoId;
  }
  if (typeof body.origen === 'string' && HOST.test(body.origen)) event.o = body.origen.toLowerCase();
  if (body.dispositivo === 'm' || body.dispositivo === 'd') event.d = body.dispositivo;
  return event;
}

// Resumen de los ultimos 30 dias. `orders` son los pagos aprobados que registra el webhook.
function summarize({ events, orders, productNames, now = Date.now() }) {
  const since = now - 30 * DAY_MS;
  const recent = events.filter((e) => e.t >= since);

  // "Nueva" = su primera visita registrada cae dentro de los ultimos 30 dias.
  const firstSeen = new Map();
  for (const e of events) {
    if (e.tipo === 'visita' && e.v && (!firstSeen.has(e.v) || e.t < firstSeen.get(e.v))) firstSeen.set(e.v, e.t);
  }

  const of = (type) => recent.filter((e) => e.tipo === type);
  const unique = (list) => new Set(list.map((e) => e.v).filter(Boolean));
  const count = (list, key) => {
    const map = new Map();
    for (const e of list) {
      const k = key(e);
      if (k) map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };
  const ranked = (map, field) => [...map].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, [field]: n }));

  const visits = of('visita');
  const visitors = unique(visits);
  const fresh = [...visitors].filter((v) => firstSeen.get(v) >= since).length;

  // Ultimos 14 dias, una fila por dia aunque no haya eventos.
  const perDay = new Map();
  for (const e of visits) {
    const day = dayOf(e.t);
    if (!perDay.has(day)) perDay.set(day, { visits: 0, people: new Set() });
    const row = perDay.get(day);
    row.visits += 1;
    if (e.v) row.people.add(e.v);
  }
  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = dayOf(now - i * DAY_MS);
    const row = perDay.get(day);
    daily.push({ day, visits: row ? row.visits : 0, unique: row ? row.people.size : 0 });
  }

  const paid = orders.filter((o) => Date.parse(o.recordedAt) >= since);
  const sold = new Map();
  for (const order of paid) {
    for (const item of order.items ?? []) {
      if (typeof item.id === 'string' && Number.isFinite(item.qty)) sold.set(item.id, (sold.get(item.id) || 0) + item.qty);
    }
  }

  const opened = count(of('abrir_producto'), (e) => e.id);
  const carted = count(of('agregar_carrito'), (e) => e.id);
  const ids = new Set([...opened.keys(), ...carted.keys(), ...sold.keys()]);
  const products = [...ids]
    .map((id) => ({
      id,
      name: productNames.get(id) ?? null,
      opened: opened.get(id) || 0,
      carted: carted.get(id) || 0,
      sold: sold.get(id) || 0,
    }))
    .sort((a, b) => (b.sold - a.sold) || (b.carted - a.carted) || (b.opened - a.opened) || a.id.localeCompare(b.id))
    .slice(0, 10);

  return {
    days: 30,
    traffic: { visits: visits.length, unique: visitors.size, new: fresh, returning: visitors.size - fresh },
    daily,
    funnel: {
      visited: visitors.size,
      openedProduct: unique(of('abrir_producto')).size,
      addedToCart: unique(of('agregar_carrito')).size,
      startedCheckout: unique(of('iniciar_checkout')).size,
      paidOrders: paid.length,
    },
    sales: {
      orders: paid.length,
      total: Math.round(paid.reduce((sum, o) => sum + (Number(o.amount) || 0), 0) * 100) / 100,
      mismatched: paid.filter((o) => o.amountMatches === false).length,
    },
    products,
    whatsapp: of('click_whatsapp').length,
    sources: ranked(count(visits, (e) => e.o || 'directo'), 'visits').slice(0, 8),
    devices: ranked(count(visits, (e) => e.d), 'visits'),
  };
}

// Un evento por linea en metrics.ndjson. Se conservan 90 dias.
function createMetricsStore(dir, { now = Date.now } = {}) {
  const file = path.join(dir, 'metrics.ndjson');
  let chain = Promise.resolve();
  const locked = (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };

  function readEvents() {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const cutoff = now() - RETENTION_MS;
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.t >= cutoff) events.push(event);
      } catch {
        // linea cortada: se ignora
      }
    }
    return events;
  }

  return {
    record: (event) =>
      locked(() => {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) return;
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      }),

    readEvents,

    // Descarta lo que supera la retencion. Va por la misma cola que las escrituras.
    prune: () =>
      locked(() => {
        if (!fs.existsSync(file)) return;
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, readEvents().map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
        fs.renameSync(tmp, file);
      }),
  };
}

module.exports = { createMetricsStore, normalizeEvent, summarize };
