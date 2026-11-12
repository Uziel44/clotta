(() => {
'use strict';

const API = window.CLOTTA_API ?? (location.port === '5502' ? 'http://localhost:3000' : '');
const KEYS = { cart: 'clotta.cart.v1', favs: 'clotta.favs.v1', buyer: 'clotta.buyer.v1' };
const WA_FALLBACK = '543516176285'; // solo hasta que cargue catalog.json (aviso de retorno de pago)
const MAX_QTY = 10;
const track = (tipo, datos) => window.Metricas?.track(tipo, datos); // metricas.js carga con defer

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// localStorage puede no estar disponible (modo privado, bloqueado): el sitio funciona igual.
const storage = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin persistencia */ } }
};

// Borrador del paso 2. Solo nombre, email y teléfono vienen de localStorage: la dirección nunca se guarda.
function initialDraft() {
  const saved = storage.get(KEYS.buyer, {});
  const pick = k => (typeof saved?.[k] === 'string' ? saved[k].slice(0, 120) : '');
  return { method: 'retiro', name: pick('name'), email: pick('email'), phone: pick('phone'), street: '', number: '', city: '', province: '', zip: '', notes: '' };
}

const S = {
  store: {}, categories: [], editorial: {}, products: [], byId: new Map(),
  filter: { cat: document.body.dataset.page === 'categoria' ? (document.body.dataset.cat || 'all') : 'all', favs: false, sort: 'featured' },
  step: 'review', draft: initialDraft(),
  cart: [], favs: new Set(storage.get(KEYS.favs, [])),
  money: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }),
  busy: false
};

// Páginas: index.html (portada), coleccion.html (todo) y una por categoría (denim.html, ...), generadas por generar-paginas.js.
const PAGE = document.body.dataset.page || 'home'; // home | coleccion | categoria
const pageFor = id => (id === 'all' ? 'coleccion.html' : `${id}.html`);

/* ---------- Helpers de dominio ---------- */
const money = n => S.money.format(n);
const tPrice = p => Math.round(p * (1 - (S.store.transferDiscount ?? 0)));
const pct = () => Math.round((S.store.transferDiscount ?? 0) * 100);
const inStock = p => p.inStock !== false;
const byStock = (a, b) => inStock(b) - inStock(a); // sin stock al final (sort estable)
const needsChoice = p => (p.sizes?.length || 0) > 1 || (p.colors?.length || 0) > 1;
const catName = id => S.categories.find(c => c.id === id)?.name || '';
const keyOf = l => [l.id, l.size || '', l.color || ''].join('|');
const waLink = text => `https://wa.me/${S.store.whatsapp || WA_FALLBACK}${text ? '?text=' + encodeURIComponent(text) : ''}`;
const announce = msg => { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 40); };
const icon = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

/* ---------- Carga del catálogo ---------- */
async function loadCatalog() {
  try {
    const res = await fetch('catalog.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    hydrate(await res.json());
  } catch (e) {
    showLoadError(e);
  }
}

function hydrate(data) {
  S.store = data.store || {};
  S.categories = data.categories || [];
  S.editorial = data.editorial || {};
  S.products = (data.products || []).filter(p => p && p.id && p.name && Number.isFinite(p.price));
  S.byId = new Map(S.products.map(p => [p.id, p]));
  S.money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: S.store.currency || 'ARS', maximumFractionDigits: 0 });
  S.cart = sanitizeCart(storage.get(KEYS.cart, []));
  S.favs = new Set([...S.favs].filter(id => S.byId.has(id)));
  if (!S.categories.some(c => c.id === S.filter.cat)) S.filter.cat = 'all';
  if (PAGE === 'coleccion' && new URLSearchParams(location.search).get('favs') === '1' && S.favs.size) S.filter.favs = true;
  renderAll();
  injectJSONLD();
}

function sanitizeCart(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const l of raw) {
    const p = S.byId.get(l?.id);
    if (!p) continue;
    if (p.sizes?.length && !p.sizes.includes(l.size)) continue;
    if (p.colors?.length && !p.colors.includes(l.color)) continue;
    const qty = Math.min(MAX_QTY, Math.max(1, parseInt(l.qty, 10) || 1));
    out.push({ id: p.id, size: l.size || '', color: l.color || '', qty });
  }
  return out;
}

function showLoadError(e) {
  const hint = location.protocol === 'file:' ? ' Abrí el sitio desde un servidor local (por ejemplo Live Server) y no como archivo.' : '';
  const html = `<div class="state" role="alert">
      <p><strong>No pudimos cargar la colección.</strong> Revisá tu conexión y probá de nuevo.${hint}</p>
      <button class="btn" type="button" data-act="retry">Reintentar</button>
      <p class="muted">También podés escribirnos por <a href="https://wa.me/543516176285" target="_blank" rel="noopener">WhatsApp</a>.</p>
    </div>`;
  const grid = $('#grid'), rail = $('#rail'), count = $('#resultCount');
  if (grid) grid.innerHTML = html;
  if (rail) rail.innerHTML = '';
  if (count) count.textContent = '';
  console.error('[CLOTTA] catálogo:', e);
}

function renderSkeletons() {
  const grid = $('#grid'), rail = $('#rail');
  if (grid) grid.innerHTML = Array.from({ length: 8 }, () => '<div><div class="skel"></div></div>').join('');
  if (rail) rail.innerHTML = Array.from({ length: 5 }, () => '<div class="card"><div class="skel"></div></div>').join('');
}

/* ---------- Render ---------- */
function renderAll() {
  bindStatic();
  renderNav();
  // Cada página tiene solo algunas secciones: se dibuja lo que existe.
  if ($('#cats')) renderCats();
  if ($('#rail')) renderRail();
  if ($('#grid')) renderGrid();
  if ($('#reels')) renderReels();
  if ($('#benefits')) renderBenefits();
  renderFooter();
  renderCounts();
  renderCart();
}

function bindStatic() {
  $$('[data-b="discountPct"]').forEach(n => { n.textContent = pct() + '%'; });
  $$('[data-b="installments"]').forEach(n => { n.textContent = S.store.installments ?? 3; });
  $$('[data-b="waLink"]').forEach(n => { n.href = waLink('Hola CLOTTA! Quiero hacer una consulta.'); });
  $$('[data-b="waNews"]').forEach(n => { n.href = waLink('Hola! Quiero enterarme de las novedades de Clotta'); });
  const hero = S.editorial.heroNavy, heroImg = $('#heroImg'); // la imagen de portada solo está en index.html
  if (hero && heroImg && !heroImg.src.endsWith(hero)) heroImg.src = hero;
  layoutPromo(); // el descuento y las cuotas pueden cambiar el ancho de la lista
}

// Cartel de promos: repite la lista hasta cubrir la pantalla y la desplaza de derecha a izquierda, sin pausa.
let promoVw = 0;
function layoutPromo() {
  const promo = $('.promo'), track = $('.promo__track'), list = $('.promo__list');
  promoVw = innerWidth;
  $$('.promo__list[aria-hidden]').forEach(n => n.remove());
  promo.classList.toggle('is-live', !reduceMotion());
  const w = list.offsetWidth;
  if (reduceMotion() || !w) return;
  for (let i = 0; i < Math.ceil(innerWidth / w); i++) {
    const copy = list.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    track.appendChild(copy);
  }
  promo.style.setProperty('--promo-shift', `-${w}px`);
  promo.style.setProperty('--promo-dur', `${w / 60}s`); // 60 px por segundo
}

// Degradé en el borde derecho del nav mientras queden categorías por ver (mobile).
function updateNavFade() {
  const ul = $('#catNav');
  ul.parentElement.classList.toggle('is-end', ul.scrollLeft + ul.clientWidth >= ul.scrollWidth - 4);
}
$('#catNav').addEventListener('scroll', updateNavFade, { passive: true });
addEventListener('resize', updateNavFade);

function renderNav() {
  const items = [{ id: 'all', name: 'Todo' }, ...S.categories.filter(c => S.products.some(p => p.category === c.id))];
  $('#catNav').innerHTML = items.map(c => {
    const on = PAGE !== 'home' && !S.filter.favs && S.filter.cat === c.id;
    return `<li><a href="${esc(pageFor(c.id))}"${on ? ' aria-current="page"' : ''}>${esc(c.name)}</a></li>`;
  }).join('');
  updateNavFade();
}

// El precio de lista solo se muestra en la ficha (popup del producto); las tarjetas no llevan precio y el valor por transferencia va en el carrito.
function priceHTML(p) {
  return `<p class="price"><span class="price__list">${money(p.price)}</span></p>`;
}

function cardHTML(p) {
  const [a, b] = p.images || [];
  const fav = S.favs.has(p.id);
  const out = !inStock(p);
  return `<article class="card${out ? ' is-out' : ''}" data-pid="${esc(p.id)}">
    <div class="card__media">
      <button class="card__img" type="button" data-act="open" tabindex="-1" aria-hidden="true">
        ${a ? `<img src="${esc(a)}" alt="" width="480" height="640" loading="lazy" decoding="async">` : ''}
        ${b ? `<img class="card__alt" src="${esc(b)}" alt="" width="480" height="640" loading="lazy" decoding="async">` : ''}
      </button>
      ${out ? '<span class="badge">Sin stock</span>' : ''}
      <button class="fav" type="button" data-act="fav" aria-pressed="${fav}" aria-label="Guardar ${esc(p.name)} en favoritos">${icon('heart')}</button>
    </div>
    <div class="card__info">
      <div class="card__row">
        <h3 class="card__title"><button class="card__name" type="button" data-act="open">${esc(p.name)}</button></h3>
        <button class="quick" type="button" data-act="quick"${out ? ' disabled' : ''} aria-label="${needsChoice(p) ? 'Elegir talle y color de' : 'Agregar al carrito:'} ${esc(p.name)}">${icon('bag')}</button>
      </div>
    </div>
  </article>`;
}

function renderRail() {
  let list = S.products.filter(p => p.featured);
  if (!list.length) list = S.products.slice(0, 8);
  $('#rail').innerHTML = [...list].sort(byStock).map(cardHTML).join('');
}

function visibleProducts() {
  const { cat, favs, sort } = S.filter;
  let list = S.products.filter(p => (cat === 'all' || p.category === cat) && (!favs || S.favs.has(p.id)));
  if (sort === 'featured') list = [...list].sort(byStock);
  else if (sort === 'price-asc') list = [...list].sort((a, b) => a.price - b.price);
  else if (sort === 'price-desc') list = [...list].sort((a, b) => b.price - a.price);
  else if (sort === 'az') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return list;
}

function renderGrid() {
  const list = visibleProducts();
  const title = $('#colT');
  if (title) title.textContent = S.filter.favs ? 'Favoritos' : S.filter.cat === 'all' ? 'Toda la colección' : catName(S.filter.cat);
  $('#resultCount').textContent = list.length === 1 ? '1 prenda' : `${list.length} prendas`;
  if (!list.length) {
    $('#grid').innerHTML = `<div class="state"><p>${S.filter.favs
      ? 'Todavía no guardaste favoritos. Tocá el corazón de una prenda para verla acá.'
      : 'No hay prendas en esta categoría por ahora.'}</p><a class="btn btn--ghost" href="${pageFor('all')}">Ver toda la colección</a></div>`;
    return;
  }
  const wa = S.filter.favs ? '' : `<div class="wa-card" id="waCard">
      <p class="display">¿No encontrás tu talle?</p>
      <p class="muted">Escribinos por WhatsApp y lo vemos.</p>
      <a class="btn" href="${esc(waLink('Hola! Busco un talle que no encuentro en la web.'))}" target="_blank" rel="noopener">Escribir por WhatsApp<span class="vh"> (se abre en otra pestaña)</span></a>
    </div>`;
  $('#grid').innerHTML = list.map(cardHTML).join('') + wa;
  fillWA();
}

// La tarjeta de WhatsApp ocupa los huecos de la última fila, sea cual sea la cantidad de columnas.
function fillWA() {
  const g = $('#grid'), w = $('#waCard');
  if (!w) return;
  const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
  const rem = (g.children.length - 1) % cols;
  w.style.gridColumn = `span ${rem === 0 ? cols : cols - rem}`;
}
if ($('#grid')) new ResizeObserver(fillWA).observe($('#grid'));

// Franja de categorías bajo el hero, de borde a borde: la primera foto de cada categoría y su nombre en un recuadro.
function renderCats() {
  $('#cats').innerHTML = S.categories.map(c => {
    const cover = S.products.find(p => p.category === c.id && p.images?.[0])?.images[0];
    if (!cover) return '';
    return `<a class="cats__item" href="${esc(pageFor(c.id))}">
      <img src="${esc(cover)}" alt="" width="1024" height="1280" loading="lazy" decoding="async">
      <span class="cats__label">${esc(c.name)}</span>
    </a>`;
  }).join('');
}

// Solo links de instagram.com; acepta /p/, /reel/, /reels/ y /tv/ e ignora querystring.
function reelInfo(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/);
    if (!/^(www\.)?instagram\.com$/.test(u.hostname) || !m) return null;
    return { id: m[1], href: `https://www.instagram.com/p/${m[1]}/` };
  } catch { return null; }
}

// Facade: no se contacta a Instagram hasta que la persona toca "Ver el video".
function renderReels() {
  // Portada: la que traiga el reel en catalog.json ("cover"); si no, la foto de un producto destacado (una distinta por reel).
  const covers = S.products.filter(p => p.featured && p.images?.[0]).map(p => p.images[0]);
  const list = (S.editorial.reels || [])
    .map((r, i) => { const info = reelInfo(r?.url); return info && { ...info, cover: r.cover || covers[i % (covers.length || 1)] }; })
    .filter(Boolean);
  $('#reels').hidden = !list.length;
  if (!list.length) return;
  $('#reelCta').href = list[0].href;
  $('#reelRail').innerHTML = list.map(r => `<figure class="reel" data-reel="${esc(r.id)}">
    <div class="reel__frame${r.cover ? ' has-cover' : ''}">
      ${r.cover ? `<img class="reel__cover" src="${esc(r.cover)}" alt="" loading="lazy" decoding="async">` : ''}
      <button class="reel__play" type="button" data-act="reel-load" aria-label="Ver el video de Instagram">
        <span class="reel__disc">${icon('play')}</span><b>Ver el video</b><small>Al tocar, se carga desde Instagram.</small>
      </button>
    </div>
    <figcaption><a class="link" href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">Ver en Instagram<span class="vh"> (se abre en otra pestaña)</span></a></figcaption>
  </figure>`).join('');
}

function mountReel(btn) {
  const fig = btn.closest('.reel');
  const f = document.createElement('iframe');
  f.className = 'reel__iframe';
  f.src = `https://www.instagram.com/p/${fig.dataset.reel}/embed/`;
  f.title = 'Video de Instagram';
  f.loading = 'lazy';
  f.allowFullscreen = true;
  f.allow = 'encrypted-media; picture-in-picture';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.setAttribute('scrolling', 'no');
  f.setAttribute('frameborder', '0');
  $('.reel__frame', fig).replaceChildren(f);
  f.focus();
}

function renderBenefits() {
  const n = S.store.installments ?? 3;
  const items = [
    ['card', `Hasta ${n} cuotas sin interés`, 'Con cualquier tarjeta bancaria, pagando por Mercado Pago.'],
    ['bank', `${pct()}% menos por transferencia`, 'También pagando en efectivo en el local. Te pasamos los datos por WhatsApp.'],
    ['truck', 'Envíos a todo el país', 'Córdoba capital en 1 a 3 días hábiles. Interior y otras provincias en 5 a 10 días hábiles.'],
    ['swap', 'Cambios y devoluciones por 30 días', 'Misma temporada y con la etiqueta puesta.']
  ];
  $('#benefits').innerHTML = items.map(([i, t, d]) => `<div class="benefit">${icon(i)}<h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('');
}

function renderFooter() {
  const st = S.store;
  const cats = S.categories.filter(c => S.products.some(p => p.category === c.id));
  $('#footGrid').innerHTML = `
    <div>
      <a class="logo" href="index.html" aria-label="${esc(st.name || 'CLOTTA')}, ir al inicio"><img src="img/logo.webp" alt="" width="480" height="208"></a>
      <p>${esc(st.tagline || '')}${st.city ? '. ' + esc(st.city) + '.' : ''}</p>
    </div>
    <div>
      <h2>Comprar</h2>
      <ul>
        <li><a href="${pageFor('all')}">Toda la colección</a></li>
        ${cats.map(c => `<li><a href="${esc(pageFor(c.id))}">${esc(c.name)}</a></li>`).join('')}
      </ul>
    </div>
    <div id="envios">
      <h2>Envíos</h2>
      <ul>
        <li>Córdoba capital: Pack Go u otro medio, en 1 a 3 días hábiles.</li>
        <li>Interior y otras provincias: Oca o Correo Argentino, en 5 a 10 días hábiles, con número de seguimiento.</li>
        <li>Retiro en el local: ${esc(st.address || '')}.</li>
      </ul>
    </div>
    <div id="pagos">
      <h2>Pagos</h2>
      <ul>
        <li>Tarjeta en hasta ${st.installments ?? 3} cuotas sin interés, con Mercado Pago.</li>
        <li>Transferencia o efectivo con ${pct()}% de descuento.</li>
      </ul>
    </div>
    <div id="cambios">
      <h2>Cambios y devoluciones</h2>
      <ul>
        <li>Tenés 30 días corridos desde que recibís tu pedido.</li>
        <li>La prenda tiene que ser de la misma temporada y conservar la etiqueta.</li>
        <li>Las devoluciones se resuelven con una nota de crédito válida por 30 días.</li>
        <li>Para empezar, escribinos por WhatsApp.</li>
      </ul>
    </div>
    <div id="local">
      <h2>Local y contacto</h2>
      <ul>
        <li>${esc(st.address || '')}</li>
        <li>WhatsApp: <a href="${esc(waLink(''))}" target="_blank" rel="noopener">${esc(st.whatsappDisplay || st.whatsapp || '')}</a></li>
        <li><a href="mailto:${esc(st.email || '')}">${esc(st.email || '')}</a></li>
      </ul>
    </div>`;
  $('#legal').textContent = `© ${new Date().getFullYear()} ${st.name || 'CLOTTA'}`;
}

function renderCounts() {
  const n = S.cart.reduce((s, l) => s + l.qty, 0);
  const c = $('#cartCount'); c.textContent = n; c.hidden = !n;
  $('#cartBtn').setAttribute('aria-label', n ? `Abrir carrito, ${n} ${n === 1 ? 'producto' : 'productos'}` : 'Abrir carrito');
  const f = $('#favCount'); f.textContent = S.favs.size; f.hidden = !S.favs.size;
  $('#favBtn').setAttribute('aria-label', S.favs.size ? `Ver favoritos, ${S.favs.size}` : 'Ver favoritos');
}

/* ---------- Diálogos ---------- */
function openDialog(d) {
  if (!d.open) d.showModal();
  document.documentElement.classList.add('is-locked');
}
document.addEventListener('close', e => {
  if (e.target instanceof HTMLDialogElement && !$('dialog[open]')) document.documentElement.classList.remove('is-locked');
}, true);
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

/* ---------- Producto ---------- */
function optionGroup(name, label, values, disabled = false) {
  if (!values?.length) return '';
  const single = values.length === 1;
  return `<fieldset class="opt" data-group="${name}"${disabled ? ' disabled' : ''}><legend>${label}</legend><div class="opt__row">${values.map(v =>
    `<label class="chip-opt"><input type="radio" name="${name}" value="${esc(v)}"${single ? ' checked' : ''}><span>${esc(v)}</span></label>`).join('')}</div></fieldset>`;
}

function productHTML(p) {
  const imgs = p.images || [];
  const out = !inStock(p);
  const nColors = p.colorCount || 0;
  return `
    <button class="icon-btn modal__x" type="button" data-act="close" aria-label="Cerrar"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>
    <div class="gal">
      ${imgs[0] ? `<img class="gal__main" id="galMain" src="${esc(imgs[0])}" alt="${esc(p.name)}" width="600" height="800">` : ''}
      ${imgs.length > 1 ? `<div class="gal__thumbs">${imgs.map((s, i) => `<button type="button" data-act="thumb" data-src="${esc(s)}" aria-label="Ver foto ${i + 1}"${i === 0 ? ' aria-current="true"' : ''}><img src="${esc(s)}" alt="" width="64" height="85"></button>`).join('')}</div>` : ''}
    </div>
    <form class="pinfo" id="pdForm" novalidate data-pid="${esc(p.id)}">
      <div>
        <p class="muted">${esc(catName(p.category))}</p>
        <h2 class="display" id="pdT">${esc(p.name)}</h2>
      </div>
      ${priceHTML(p)}
      ${p.description ? `<p class="pinfo__desc">${esc(p.description)}</p>` : ''}
      ${optionGroup('color', 'Color', p.colors, out)}
      ${!p.colors?.length && nColors > 1 ? `<p class="muted">Hay ${nColors} colores. Lo coordinamos con vos por WhatsApp después de tu pedido.</p>` : ''}
      ${optionGroup('size', 'Talle', p.sizes, out)}
      <p class="form-err" id="pdErr" role="alert"></p>
      ${out
        ? `<p class="muted">Sin stock por ahora.</p>
           <a class="btn" href="${esc(waLink(`Hola! Quiero consultar por ${p.name}, que figura sin stock en la web.`))}" target="_blank" rel="noopener">Consultar por WhatsApp<span class="vh"> (se abre en otra pestaña)</span></a>`
        : '<button class="btn" type="submit">Agregar al carrito</button>'}
    </form>`;
}

function openProduct(id) {
  const p = S.byId.get(id);
  if (!p) return;
  track('abrir_producto', { productoId: p.id });
  $('#pdIn').innerHTML = productHTML(p);
  openDialog($('#pd'));
}

function readChoice(form, p) {
  const pick = n => form.querySelector(`input[name="${n}"]:checked`)?.value || '';
  const size = pick('size'), color = pick('color');
  if (p.colors?.length && !color) return { error: 'Elegí un color.', focus: 'color' };
  if (p.sizes?.length && !size) return { error: 'Elegí un talle.', focus: 'size' };
  return { size, color };
}

/* ---------- Favoritos ---------- */
function toggleFav(id) {
  if (S.favs.has(id)) S.favs.delete(id); else S.favs.add(id);
  storage.set(KEYS.favs, [...S.favs]);
  const p = S.byId.get(id);
  announce(S.favs.has(id) ? `${p.name} guardado en favoritos.` : `${p.name} quitado de favoritos.`);
  if (S.filter.favs && !S.favs.size) S.filter.favs = false;
  renderCounts(); renderNav();
  $$(`[data-pid="${CSS.escape(id)}"] .fav`).forEach(b => b.setAttribute('aria-pressed', S.favs.has(id)));
  if (S.filter.favs) renderGrid();
}

/* ---------- Carrito ---------- */
function totals() {
  return S.cart.reduce((t, l) => {
    const p = S.byId.get(l.id);
    t.list += p.price * l.qty;
    t.transfer += tPrice(p.price) * l.qty;
    return t;
  }, { list: 0, transfer: 0 });
}
function saveCart() { storage.set(KEYS.cart, S.cart); renderCounts(); renderCart(); }

function addToCart(p, { size = '', color = '' } = {}, qty = 1) {
  const line = S.cart.find(l => keyOf(l) === keyOf({ id: p.id, size, color }));
  if (line) line.qty = Math.min(MAX_QTY, line.qty + qty);
  else S.cart.push({ id: p.id, size, color, qty });
  track('agregar_carrito', { productoId: p.id });
  saveCart();
  announce(`${p.name} agregado al carrito.`);
  toast(`Agregaste ${p.name}.`, { act: 'cart', label: 'Ver carrito' });
}

function quickAdd(id) {
  const p = S.byId.get(id);
  if (!p || !inStock(p)) return;
  if (needsChoice(p)) return openProduct(id);
  addToCart(p, { size: p.sizes?.[0] || '', color: p.colors?.[0] || '' });
}

function changeQty(key, delta) {
  const l = S.cart.find(x => keyOf(x) === key);
  if (!l) return;
  l.qty = Math.min(MAX_QTY, Math.max(1, l.qty + delta));
  announce(`${S.byId.get(l.id).name}: ${l.qty} ${l.qty === 1 ? 'unidad' : 'unidades'}.`);
  saveCart();
}
function removeLine(key) {
  const l = S.cart.find(x => keyOf(x) === key);
  S.cart = S.cart.filter(x => keyOf(x) !== key);
  if (l) announce(`${S.byId.get(l.id).name} quitado del carrito.`);
  saveCart();
}

function renderCart(focus) {
  const body = $('#cartBody'), foot = $('#cartFoot');
  const n = S.cart.reduce((s, l) => s + l.qty, 0);
  $('#cartT').textContent = n ? `Tu carrito (${n})` : 'Tu carrito';
  if (!S.cart.length) {
    S.step = 'review';
    body.innerHTML = `<div class="empty"><p>Tu carrito está vacío. Sumá prendas desde la colección.</p><button class="btn" type="button" data-cart="shop">Ver la colección</button></div>`;
    foot.hidden = true;
    return;
  }
  foot.hidden = false;
  if (S.step === 'details') return renderDetails();
  const outLines = S.cart.filter(l => !inStock(S.byId.get(l.id)));
  body.innerHTML = `<ul class="lines">${S.cart.map(l => {
    const p = S.byId.get(l.id), k = keyOf(l);
    const variant = [l.size && `Talle ${l.size}`, l.color && `color ${l.color}`].filter(Boolean).join(', ');
    return `<li class="line" data-key="${esc(k)}">
      ${p.images?.[0] ? `<img src="${esc(p.images[0])}" alt="" width="76" height="101">` : '<span></span>'}
      <div class="line__info">
        <span class="line__name">${esc(p.name)}</span>
        ${variant ? `<span class="line__var">${esc(variant)}</span>` : ''}
        ${inStock(p) ? '' : '<span class="form-err">Sin stock. Quitala para continuar.</span>'}
        <div class="line__row">
          <div class="stepper" role="group" aria-label="Cantidad de ${esc(p.name)}">
            <button type="button" data-cart="dec" aria-label="Quitar una unidad"${l.qty <= 1 ? ' disabled' : ''}>${icon('minus')}</button>
            <output>${l.qty}</output>
            <button type="button" data-cart="inc" aria-label="Sumar una unidad"${l.qty >= MAX_QTY ? ' disabled' : ''}>${icon('plus')}</button>
          </div>
          <p class="line__price">${money(p.price * l.qty)}<span class="price__t">${money(tPrice(p.price) * l.qty)} transf.</span></p>
        </div>
        <button class="link" type="button" data-cart="rm">Quitar</button>
      </div>
    </li>`;
  }).join('')}</ul>`;
  const t = totals();
  const blocked = outLines.length > 0;
  foot.innerHTML = `
    <div class="totals">
      <div><span>Total con tarjeta</span><span>${money(t.list)}</span></div>
      <div class="t-big"><span>Total por transferencia (−${pct()}%)</span><span>${money(t.transfer)}</span></div>
    </div>
    <p class="pay-note">En el próximo paso elegís retiro en el local o envío.</p>
    <button class="btn" type="button" data-cart="next"${blocked ? ' disabled' : ''}>Continuar</button>`;
  if (focus) {
    const el = $(`[data-key="${CSS.escape(focus.key)}"] [data-cart="${focus.act}"]:not([disabled])`) || $('#cartBody .stepper button:not([disabled])');
    el?.focus();
  }
}

function showCartError(html) {
  const el = $('#cartErr');
  if (el) el.innerHTML = html;
}

function orderLines() {
  return S.cart.map(l => {
    const p = S.byId.get(l.id);
    const v = [l.size && `talle ${l.size}`, l.color && `color ${l.color}`].filter(Boolean).join(', ');
    return `• ${l.qty} × ${p.name}${v ? ` (${v})` : ''}`;
  }).join('\n');
}

/* ---------- Paso 2: datos del comprador y entrega ---------- */
const FIELD_ORDER = ['name', 'email', 'phone', 'street', 'number', 'city', 'province', 'zip', 'notes'];
// El server informa `field` (ej. 'buyer.email'): nos quedamos con el último tramo.
const FIELD_ALIAS = { nombre: 'name', telefono: 'phone', calle: 'street', numero: 'number', localidad: 'city', provincia: 'province', cp: 'zip', address: 'street', buyer: 'name', delivery: 'method' };
// Mismas reglas que server/lib/pricing.js, para avisar antes de pedir el pago.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PHONE_RE = /^[0-9+()\-\s]{8,20}$/;
const ZIP_RE = /^[A-Za-z0-9 -]{3,10}$/;
const NUMBER_RE = /^[A-Za-z0-9./\- ]{1,10}$/;
const UNSAFE_RE = /[<>]/;

function fieldHTML({ id, label, type = 'text', ac = 'off', mode = '', hint = '', value = '', max = 120, opt = false, area = false }) {
  const attrs = `id="f-${id}" name="${id}" autocomplete="${ac}" maxlength="${max}" aria-invalid="false" aria-describedby="${hint ? `f-${id}-hint ` : ''}f-${id}-err"${opt ? '' : ' required aria-required="true"'}${mode ? ` inputmode="${mode}"` : ''}`;
  return `<div class="fld">
    <label for="f-${id}">${label}${opt ? ' (opcional)' : ''}</label>
    ${area ? `<textarea ${attrs} rows="2">${esc(value)}</textarea>` : `<input ${attrs} type="${type}" value="${esc(value)}">`}
    ${hint ? `<p class="hint" id="f-${id}-hint">${hint}</p>` : ''}
    <p class="field-err" id="f-${id}-err"></p>
  </div>`;
}

function renderDetails() {
  const body = $('#cartBody'), foot = $('#cartFoot'), d = S.draft, env = d.method === 'envio';
  const t = totals(), blocked = S.cart.some(l => !inStock(S.byId.get(l.id)));
  $('#cartT').textContent = 'Tus datos y la entrega';
  body.innerHTML = `
    <div class="step-row">
      <button class="link back" type="button" data-cart="back">${icon('prev')} Volver al carrito</button>
      <span class="muted">Paso 2 de 2</span>
    </div>
    <form class="cart-form" id="checkoutForm" novalidate>
      <fieldset class="fset">
        <legend>Tus datos</legend>
        ${fieldHTML({ id: 'name', label: 'Nombre y apellido', ac: 'name', max: 80, value: d.name })}
        ${fieldHTML({ id: 'email', label: 'Email', type: 'email', ac: 'email', mode: 'email', value: d.email })}
        ${fieldHTML({ id: 'phone', label: 'Teléfono o WhatsApp', type: 'tel', ac: 'tel', mode: 'tel', max: 20, value: d.phone, hint: 'Con código de área, por ejemplo 351 6176285.' })}
        <p class="hint">Guardamos nombre, email y teléfono solo en tu navegador, para tu próxima compra. La dirección no se guarda.</p>
      </fieldset>
      <fieldset class="fset" aria-describedby="method-err">
        <legend>Entrega</legend>
        <div class="deliv">
          <label class="opt-card"><input type="radio" name="delivery" value="retiro"${env ? '' : ' checked'}><span class="opt-card__t">Retiro en el local</span><span class="opt-card__d">${esc(S.store.address || '')}</span></label>
          <label class="opt-card"><input type="radio" name="delivery" value="envio"${env ? ' checked' : ''}><span class="opt-card__t">Envío a domicilio</span><span class="opt-card__d">A todo el país.</span></label>
        </div>
        <p class="field-err" id="method-err"></p>
        <div class="addr" id="addrBox"${env ? '' : ' hidden'}>
          <div class="row2">${fieldHTML({ id: 'street', label: 'Calle', ac: 'street-address', value: d.street })}${fieldHTML({ id: 'number', label: 'Número', max: 10, value: d.number })}</div>
          <div class="row2 row2--eq">${fieldHTML({ id: 'city', label: 'Localidad', ac: 'address-level2', value: d.city })}${fieldHTML({ id: 'province', label: 'Provincia', ac: 'address-level1', value: d.province })}</div>
          <div class="row2 row2--eq">${fieldHTML({ id: 'zip', label: 'Código postal', ac: 'postal-code', max: 10, value: d.zip })}<span></span></div>
        </div>
        <p class="callout" id="deliveryNote"${env ? '' : ' hidden'}>El envío no se cobra acá: te escribimos por WhatsApp para coordinar el costo antes de despachar.</p>
        ${fieldHTML({ id: 'notes', label: 'Notas para la entrega', opt: true, area: true, max: 200, value: d.notes })}
      </fieldset>
    </form>`;
  foot.innerHTML = `
    <div class="totals">
      <div><span>Total con tarjeta</span><span>${money(t.list)}</span></div>
      <div class="t-big"><span>Total por transferencia (−${pct()}%)</span><span>${money(t.transfer)}</span></div>
    </div>
    <div class="err" id="cartErr" role="alert"></div>
    <button class="btn" type="submit" form="checkoutForm" id="mpBtn"${blocked ? ' disabled' : ''}>${icon('card')} Pagar con Mercado Pago</button>
    <p class="pay-note pay-note--tight">Cobra solo las prendas. Hasta ${S.store.installments ?? 3} cuotas sin interés con tarjeta.</p>
    <button class="btn btn--ghost" type="button" data-cart="transfer"${blocked ? ' disabled' : ''}>${icon('bank')} Pagar por transferencia (−${pct()}%)</button>`;
  body.scrollTop = 0;
}

function syncDraft() {
  for (const k of FIELD_ORDER) { const el = $('#f-' + k); if (el) S.draft[k] = el.value; }
  S.draft.method = $('input[name="delivery"]:checked')?.value || S.draft.method;
}

function validateDraft(d) {
  const e = {};
  const name = d.name.trim(), phone = d.phone.trim(), zip = d.zip.trim(), number = d.number.trim();
  if (name.length < 3 || name.split(/\s+/).length < 2) e.name = 'Escribí tu nombre y apellido.';
  else if (UNSAFE_RE.test(name)) e.name = 'El nombre no puede incluir < ni >.';
  if (!EMAIL_RE.test(d.email.trim())) e.email = 'Revisá el email: tiene que ser como nombre@correo.com.';
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 6) e.phone = 'Revisá el teléfono: solo números, con código de área, por ejemplo 351 6176285.';
  if (d.method === 'envio') {
    if (d.street.trim().length < 2) e.street = 'Escribí la calle.';
    else if (UNSAFE_RE.test(d.street)) e.street = 'La calle no puede incluir < ni >.';
    if (!number) e.number = 'Escribí el número, o S/N si no tiene.';
    else if (!NUMBER_RE.test(number)) e.number = 'Revisá el número: hasta 10 caracteres, o S/N.';
    if (d.city.trim().length < 2) e.city = 'Escribí la localidad.';
    if (d.province.trim().length < 2) e.province = 'Escribí la provincia.';
    if (!ZIP_RE.test(zip)) e.zip = 'Revisá el código postal, por ejemplo 5000.';
  }
  if (UNSAFE_RE.test(d.notes)) e.notes = 'Las notas no pueden incluir < ni >.';
  return e;
}

// Marca los campos con error junto a cada input y lleva el foco al primero.
function showFieldErrors(errs, { focus = true } = {}) {
  let first = null;
  for (const k of FIELD_ORDER) {
    const el = $('#f-' + k);
    if (!el) continue;
    const msg = errs[k] || '';
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    $(`#f-${k}-err`).textContent = msg;
    if (msg && !first) first = el;
  }
  const m = $('#method-err');
  if (m) { m.textContent = errs.method || ''; if (errs.method && !first) first = $('input[name="delivery"]'); }
  if (first && focus) first.focus();
  const n = Object.keys(errs).length;
  if (n) announce(n === 1 ? 'Hay un dato para revisar.' : `Hay ${n} datos para revisar.`);
  return first;
}

function readCheckout() {
  syncDraft();
  const d = S.draft, errs = validateDraft(d);
  if (Object.keys(errs).length) { showFieldErrors(errs); return null; }
  showFieldErrors({}, { focus: false });
  const buyer = { name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim() };
  storage.set(KEYS.buyer, buyer);
  const delivery = { method: d.method };
  if (d.method === 'envio') delivery.address = { street: d.street.trim(), number: d.number.trim(), city: d.city.trim(), province: d.province.trim(), zip: d.zip.trim() };
  if (d.notes.trim()) delivery.notes = d.notes.trim();
  return { buyer, delivery };
}

function orderMessage(c, mode) {
  const t = totals(), a = c.delivery.address;
  const entrega = a ? `Envío a domicilio: ${a.street} ${a.number}, ${a.city}, ${a.province} (CP ${a.zip})` : `Retiro en el local (${S.store.address})`;
  return [
    mode === 'transfer' ? `Hola CLOTTA! Quiero pagar este pedido por transferencia (${pct()}% de descuento):` : 'Hola CLOTTA! Quiero comprar este pedido (el pago online no estaba disponible):',
    '', orderLines(), '',
    mode === 'transfer' ? `Total por transferencia: ${money(t.transfer)}` : `Total: ${money(t.list)}`,
    '', `Nombre: ${c.buyer.name}`, `Teléfono: ${c.buyer.phone}`, `Entrega: ${entrega}`,
    ...(c.delivery.notes ? [`Notas: ${c.delivery.notes}`] : []),
    ...(a ? ['El costo del envío lo coordinamos antes de despachar.'] : []),
    '', mode === 'transfer' ? '¿Me pasás los datos para transferir?' : '¿Cómo seguimos?'
  ].join('\n');
}

function payTransfer() {
  const c = readCheckout();
  if (!c) return;
  track('iniciar_checkout');
  track('click_whatsapp');
  window.open(waLink(orderMessage(c, 'transfer')), '_blank', 'noopener');
}

function goStep(step) {
  S.step = step;
  renderCart();
  if (step === 'details') { $('#f-name')?.focus(); announce('Paso 2 de 2: tus datos y la entrega.'); }
  else { $('[data-cart="next"]')?.focus(); announce('Volviste a la revisión del carrito.'); }
}

function setBusy(btn, on) {
  S.busy = on;
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
  btn.setAttribute('aria-busy', on);
}

const humanMsg = s => (typeof s === 'string' && /\s/.test(s) ? s : '');
const CODE_MSG = {
  buyer_invalido: 'Revisá tus datos de contacto.',
  entrega_invalida: 'Revisá cómo querés recibir tu pedido.',
  direccion_invalida: 'Revisá la dirección de envío.'
};

// 400 del server: si trae `field`, el mensaje va junto a ese campo; si no, arriba de los botones de pago.
function handleCheckout400(data) {
  const msg = humanMsg(data?.error) || CODE_MSG[data?.code] || 'Hay algo para revisar en tu carrito: una prenda ya no está disponible o la cantidad no es válida.';
  let key = String(data?.field || '').split('.').pop().toLowerCase();
  key = FIELD_ALIAS[key] || key;
  if (key === 'method' && $('input[name="delivery"]')) return showFieldErrors({ method: msg });
  if (FIELD_ORDER.includes(key) && $('#f-' + key) && !$('#f-' + key).closest('[hidden]')) return showFieldErrors({ [key]: msg });
  showCartError(`<span>${esc(msg)}</span>`);
}

async function payMP(btn) {
  if (S.busy) return;
  const c = readCheckout();
  if (!c) return;
  track('iniciar_checkout');
  showCartError('');
  setBusy(btn, true);
  const items = S.cart.map(l => ({ id: l.id, qty: l.qty, ...(l.size ? { size: l.size } : {}), ...(l.color ? { color: l.color } : {}) }));
  try {
    const res = await fetch(`${API}/api/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, buyer: c.buyer, delivery: c.delivery })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.init_point) { location.assign(data.init_point); return; }
    if (res.status === 400) {
      handleCheckout400(data);
    } else if (res.status === 503 || res.status === 404 || res.status === 405 || !data || data.error === 'pagos_no_configurados') {
      showCartError(`<span>El pago online no está disponible por ahora. Escribinos por WhatsApp y cerramos tu pedido.</span>
        <a class="btn btn--ghost" href="${esc(waLink(orderMessage(c, 'consulta')))}" target="_blank" rel="noopener">Escribir por WhatsApp</a>`);
    } else {
      showCartError('<span>No pudimos iniciar el pago. Probá de nuevo en unos minutos o pagá por transferencia.</span>');
    }
  } catch {
    showCartError('<span>No pudimos conectarnos para iniciar el pago. Tu carrito sigue guardado: probá de nuevo o pagá por transferencia.</span>');
  }
  setBusy($('#mpBtn'), false);
}
// Al volver con "atrás" desde Mercado Pago el botón no debe quedar bloqueado.
addEventListener('pageshow', e => { if (e.persisted) { S.busy = false; renderCart(); } });

/* ---------- Toast y avisos ---------- */
let toastTimer;
function toast(msg, action) {
  if ($('#cartD').open) return; // el cajón ya muestra el cambio
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="link" type="button" data-act="${action.act}">${esc(action.label)}</button>` : ''}`;
  t.inert = false; t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('is-on'); t.inert = true; }, 5000);
}

function handleReturn() {
  const q = new URLSearchParams(location.search);
  const r = q.get('pago');
  if (!r) return;
  const ref = (q.get('external_reference') || '').slice(0, 60);
  const pid = (q.get('payment_id') || '').slice(0, 30);
  const msgs = {
    exito: ['ok', '¡Pago recibido! Te escribimos por WhatsApp para coordinar la entrega o el retiro.'],
    pendiente: ['', 'Tu pago está pendiente de acreditación. Cuando se confirme, te avisamos.'],
    error: ['err', 'No se pudo completar el pago. Tu carrito sigue guardado: probá de nuevo o pagá por transferencia.']
  };
  const m = msgs[r];
  if (m) {
    if (r === 'exito') storage.set(KEYS.cart, []);
    const n = $('#notice');
    n.className = 'notice' + (m[0] ? ' notice--' + m[0] : '');
    const order = ref ? `el pedido ${ref}` : 'un pedido en la web';
    const wa = r === 'error'
      ? `Hola! Tuve un problema para pagar ${ref ? `el pedido ${ref}` : 'mi pedido'}.`
      : `Hola! Hice ${order}${pid ? `, pago ${pid}` : ''}.`;
    n.innerHTML = `<div class="wrap notice__in"><p>${esc(m[1])}${ref && r !== 'error' ? ` Pedido ${esc(ref)}.` : ''}</p>
      <a class="btn btn--ghost" href="${esc(waLink(wa))}" target="_blank" rel="noopener">Avisar por WhatsApp</a>
      <button class="icon-btn" type="button" data-act="notice-close" aria-label="Cerrar aviso">${icon('x')}</button></div>`;
    n.hidden = false;
  }
  history.replaceState(null, '', location.pathname + location.hash);
}

/* ---------- Filtros y navegación ---------- */
// "Ver la colección": en coleccion.html se queda y quita el filtro de favoritos; en otra página, va a coleccion.html.
function goAll() {
  if ($('#cartD').open) $('#cartD').close();
  if (PAGE !== 'coleccion') { location.assign(pageFor('all')); return; }
  S.filter.favs = false;
  renderNav(); renderGrid();
  window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

/* ---------- Eventos ---------- */
document.addEventListener('click', e => {
  const cartBtn = e.target.closest('[data-cart]');
  if (cartBtn) {
    const act = cartBtn.dataset.cart, key = cartBtn.closest('[data-key]')?.dataset.key;
    if (act === 'inc') changeQty(key, 1), renderCart({ key, act });
    else if (act === 'dec') changeQty(key, -1), renderCart({ key, act });
    else if (act === 'rm') removeLine(key);
    else if (act === 'next') goStep('details');
    else if (act === 'back') { syncDraft(); goStep('review'); }
    else if (act === 'transfer') payTransfer();
    else if (act === 'shop') goAll();
    return;
  }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = t.closest('[data-pid]')?.dataset.pid;
  switch (act) {
    case 'open': return openProduct(id);
    case 'quick': return quickAdd(id);
    case 'fav': return toggleFav(id);
    case 'shop': e.preventDefault(); return goAll();
    case 'favs':
      if (!S.favs.size) { toast('Todavía no guardaste favoritos. Tocá el corazón de una prenda.'); return; }
      if (PAGE !== 'coleccion') { location.assign(`${pageFor('all')}?favs=1`); return; }
      S.filter.favs = true; renderNav(); renderGrid();
      return $('#coleccion').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    case 'cart': S.step = 'review'; renderCart(); return openDialog($('#cartD'));
    case 'close': return t.closest('dialog')?.close();
    case 'thumb': {
      $('#galMain').src = t.dataset.src;
      $$('.gal__thumbs button').forEach(b => b.removeAttribute('aria-current'));
      t.setAttribute('aria-current', 'true');
      return;
    }
    case 'rail-prev': case 'rail-next': {
      const r = $('#rail'), dx = r.clientWidth * .85 * (act === 'rail-next' ? 1 : -1);
      return r.scrollBy({ left: dx, behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
    case 'reel-load': return mountReel(t);
    case 'retry': renderSkeletons(); return loadCatalog();
    case 'notice-close': $('#notice').hidden = true; return;
  }
});

document.addEventListener('submit', e => {
  if (e.target.id === 'checkoutForm') { e.preventDefault(); payMP($('#mpBtn')); return; }
  if (e.target.id !== 'pdForm') return;
  e.preventDefault();
  const form = e.target, p = S.byId.get(form.dataset.pid);
  const c = readChoice(form, p);
  if (c.error) {
    $('#pdErr').textContent = c.error;
    form.querySelector(`[data-group="${c.focus}"] input`)?.focus();
    return;
  }
  addToCart(p, c);
  $('#pd').close();
});
document.addEventListener('change', e => {
  if (e.target.closest('#pdForm')) $('#pdErr').textContent = '';
  if (e.target.name === 'delivery' && e.target.closest('#checkoutForm')) {
    S.draft.method = e.target.value;
    const env = e.target.value === 'envio';
    $('#addrBox').hidden = !env;
    $('#deliveryNote').hidden = !env;
    $('#method-err').textContent = '';
  }
});
// Al corregir un campo se limpia su error; el borrador vive solo en memoria.
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.id?.startsWith('f-') || !el.closest('#checkoutForm')) return;
  const k = el.id.slice(2);
  S.draft[k] = el.value;
  showCartError(''); // el aviso anterior ya no corresponde a lo que se está editando
  if (el.getAttribute('aria-invalid') === 'true') { el.setAttribute('aria-invalid', 'false'); $(`#f-${k}-err`).textContent = ''; }
});

$('#sort')?.addEventListener('change', e => { S.filter.sort = e.target.value; renderGrid(); });

/* ---------- JSON-LD (generado desde el catálogo) ---------- */
function injectJSONLD() {
  const abs = u => new URL(u, location.href).href;
  const st = S.store;
  const data = [{
    '@context': 'https://schema.org', '@type': 'ClothingStore', name: st.name,
    description: `${st.tagline || ''}. ${st.city || ''}`.trim(),
    telephone: st.whatsappDisplay, email: st.email,
    image: S.editorial.heroNavy ? abs(S.editorial.heroNavy) : undefined,
    address: { '@type': 'PostalAddress', streetAddress: st.address, addressLocality: (st.city || '').split(',')[0].trim(), addressCountry: 'AR' }
  }, {
    '@context': 'https://schema.org', '@type': 'ItemList',
    itemListElement: S.products.map((p, i) => ({
      '@type': 'ListItem', position: i + 1,
      item: {
        '@type': 'Product', name: p.name, description: p.description || undefined, category: catName(p.category),
        image: (p.images || []).map(abs),
        offers: { '@type': 'Offer', price: p.price, priceCurrency: st.currency || 'ARS', availability: inStock(p) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' }
      }
    }))
  }];
  let el = $('#ld');
  if (!el) { el = document.createElement('script'); el.id = 'ld'; el.type = 'application/ld+json'; document.head.appendChild(el); }
  el.textContent = JSON.stringify(data);
}

/* ---------- Init ---------- */
handleReturn();
$('#userBtn').href = `${API}/admin.html`; // con Live Server (:5502) el panel se abre en el server, que es donde está la API
layoutPromo();
addEventListener('resize', () => { if (innerWidth !== promoVw) layoutPromo(); }); // en mobile el alto cambia al scrollear
document.fonts?.ready.then(layoutPromo);
renderSkeletons();
renderCart();
loadCatalog();
})();
