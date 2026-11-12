(() => {
  'use strict';

  // ---- Configuración ----
  const TOKEN_KEY = 'clotta_admin_token';
  const NO_METRICS_KEY = 'clotta_no_metricas'; // metricas.js no cuenta las visitas de este navegador
  const MAX_SIDE = 1600;          // lado largo máximo de la imagen, en píxeles
  const IMG_QUALITY = 0.85;
  const MAX_IMAGES = 8;
  const SAFE_IMG = /^(?:img|uploads)\/[\w.-]+$/;

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const money = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);

  // El token vive en sessionStorage (se borra al cerrar la pestaña); si el navegador lo bloquea, queda en memoria
  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { /* sin almacenamiento */ }
  const saveToken = (value) => {
    token = value;
    try { value ? sessionStorage.setItem(TOKEN_KEY, value) : sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* sin almacenamiento */ }
  };

  const loginBox = $('#login');
  const loginMsg = $('#login-msg');
  const logoutBtn = $('#logout');
  const panel = $('#panel');
  const tabs = $('#tabs');
  const panelMetricas = $('#panel-metricas');
  const list = $('#list');
  const empty = $('#empty');
  const loading = $('#loading');
  const aviso = $('#aviso');
  const editor = $('#editor');
  const editorForm = $('#editor-form');
  const editorMsg = $('#editor-msg');
  const confirmDlg = $('#confirm');
  const imgsList = $('#imgs');

  let products = [];
  let categories = [];
  let transferDiscount = 0;
  let editing = null;        // producto que se edita (null = nuevo)
  let images = [];           // [{ src, url, blob }]: url = ya está en el servidor; blob = nueva, sin subir
  let deleting = null;
  let busy = false;

  const say = (text) => { aviso.textContent = text; };
  const safeImg = (src) => typeof src === 'string' && SAFE_IMG.test(src);

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const errorText = (status) => ({
    404: 'Ese producto ya no existe. Actualizamos la lista.',
    413: 'La imagen es demasiado grande. Probá con otra.',
    415: 'Ese tipo de archivo no sirve. Usá una imagen JPG, PNG o WebP.',
    429: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.',
    503: 'El panel todavía no está habilitado en el servidor.',
  }[status] || `Algo salió mal (código ${status}). Intentá de nuevo en un momento.`);

  // Llamada a la API. Si el servidor dice 401 (fuera del login) la sesión venció: vuelve al login.
  const api = async (path, { method = 'GET', json, body, type } = {}) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    else if (type) headers['Content-Type'] = type;

    let res;
    try { res = await fetch(path, { method, headers, body: payload }); }
    catch (_) { throw new ApiError(0, 'No hay conexión con el servidor. Revisá tu internet e intentá de nuevo.'); }

    if (res.status === 401 && path !== '/api/login') {
      showLogin('Tu sesión venció. Entrá de nuevo.');
      throw new ApiError(401, '');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* respuesta sin cuerpo */ }
    if (!res.ok) {
      // Los mensajes del servidor para estos códigos están escritos para quien usa el panel
      const detail = [400, 401, 429, 503].includes(res.status) && data && typeof data.error === 'string' ? data.error : '';
      throw new ApiError(res.status, detail || errorText(res.status));
    }
    return data;
  };
  const expired = (err) => err instanceof ApiError && err.status === 401;
  const messageOf = (err) => (err instanceof ApiError ? err.message : 'Algo salió mal. Intentá de nuevo.');

  // ---- Entrar / salir ----
  function showLogin(message = '') {
    saveToken('');
    products = [];
    [editor, confirmDlg].forEach((d) => { if (d.open) d.close(); });
    panel.hidden = true;
    panelMetricas.hidden = true;
    tabs.hidden = true;
    logoutBtn.hidden = true;
    loginBox.hidden = false;
    loginMsg.textContent = message;
    $('#login-pass').value = '';
    $('#login-send').disabled = false;
    $('#login-send').textContent = 'Entrar';
    (message ? $('#login-pass') : $('#login-user')).focus();
  }

  function showPanel() {
    loginBox.hidden = true;
    tabs.hidden = false;
    logoutBtn.hidden = false;
    // Las visitas de quien administra desde este navegador no se cuentan en las métricas (ver metricas.js)
    try { localStorage.setItem(NO_METRICS_KEY, '1'); } catch (_) { /* sin almacenamiento */ }
    selectTab('productos');
    loadCatalog();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const send = $('#login-send');
    send.disabled = true;
    send.textContent = 'Entrando…';
    loginMsg.textContent = '';
    try {
      const { token: t } = await api('/api/login', {
        method: 'POST',
        json: { usuario: $('#login-user').value, password: $('#login-pass').value },
      });
      saveToken(t);
      $('#login-pass').value = '';
      showPanel();
    } catch (err) {
      loginMsg.textContent = messageOf(err);
      send.disabled = false;
      send.textContent = 'Entrar';
    }
  });

  logoutBtn.addEventListener('click', () => showLogin());

  // ---- Lista de productos ----
  async function loadCatalog() {
    loading.hidden = false;
    empty.hidden = true;
    try {
      const data = await api('/api/admin/catalog');
      products = data.products;
      categories = data.categories;
      transferDiscount = data.transferDiscount || 0;
      renderList();
    } catch (err) {
      if (!expired(err)) { say(messageOf(err)); list.replaceChildren(el('li', 'msg', messageOf(err))); }
    } finally {
      loading.hidden = true;
    }
    panel.hidden = false;
  }

  const categoryName = (id) => (categories.find((c) => c.id === id) || {}).name || id;

  function renderList() {
    list.replaceChildren();
    empty.hidden = products.length > 0;
    products.forEach((p) => {
      const li = el('li', 'card' + (p.inStock === false ? ' out' : ''));
      const thumb = el('div', 'thumb');
      if (safeImg(p.images && p.images[0])) thumb.style.backgroundImage = `url("${p.images[0]}")`;
      const info = el('div');
      const h = el('h3', undefined, p.name);
      if (p.featured) h.append(el('span', 'tag', 'destacado'));
      if (p.inStock === false) h.append(el('span', 'tag', 'sin stock'));
      const extras = [];
      if (p.colors && p.colors.length) extras.push(p.colors.join(', '));
      if (p.sizes && p.sizes.length) extras.push(`talles ${p.sizes.join(', ')}`);
      info.append(
        h,
        el('div', 'meta', [categoryName(p.category), ...extras].join(' · ')),
        el('div', 'price', money(p.price)),
      );
      const actions = el('div', 'card-actions');
      const edit = el('button', 'btn ghost', 'Editar');
      edit.type = 'button';
      edit.addEventListener('click', () => openEditor(p));
      const del = el('button', 'btn ghost', 'Eliminar');
      del.type = 'button';
      del.addEventListener('click', () => askDelete(p));
      actions.append(edit, del);
      li.append(thumb, info, actions);
      list.append(li);
    });
  }

  // ---- Editor ----
  const splitList = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

  function updateTransferHint() {
    const price = Number($('#f-precio').value);
    $('#f-transfer').textContent = price > 0 && transferDiscount
      ? `Por transferencia: ${money(Math.round(price * (1 - transferDiscount)))}`
      : '';
  }
  function updateColorCountBox() {
    $('#f-ncolores-box').hidden = splitList($('#f-colores').value).length > 0;
  }
  $('#f-precio').addEventListener('input', updateTransferHint);
  $('#f-colores').addEventListener('input', updateColorCountBox);

  const releaseImages = () => images.forEach((i) => { if (i.blob) URL.revokeObjectURL(i.src); });

  function renderImages() {
    imgsList.replaceChildren();
    images.forEach((img, index) => {
      const li = el('li');
      const pic = el('div', 'pic');
      pic.style.backgroundImage = `url("${img.src}")`;
      li.append(pic);
      if (index === 0) li.append(el('span', 'tag', 'Principal'));
      const acts = el('div', 'acts');
      if (index > 0) {
        const main = el('button', 'btn ghost', 'Principal');
        main.type = 'button';
        main.addEventListener('click', () => { images.unshift(...images.splice(index, 1)); renderImages(); });
        acts.append(main);
      }
      const remove = el('button', 'btn ghost', 'Quitar');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        const [gone] = images.splice(index, 1);
        if (gone.blob) URL.revokeObjectURL(gone.src);
        renderImages();
      });
      acts.append(remove);
      li.append(acts);
      imgsList.append(li);
    });
    $('label[for="f-fotos"]').hidden = images.length >= MAX_IMAGES;
  }

  function openEditor(p) {
    editing = p || null;
    releaseImages();
    $('#editor-titulo').textContent = p ? 'Editar producto' : 'Nuevo producto';
    $('#f-nombre').value = p ? p.name : '';
    const select = $('#f-categoria');
    select.replaceChildren(...categories.map((c) => { const o = el('option', undefined, c.name); o.value = c.id; return o; }));
    select.value = p ? p.category : (categories[0] || {}).id || '';
    $('#f-precio').value = p ? p.price : '';
    $('#f-descripcion').value = p ? (p.description || '') : '';
    $('#f-colores').value = p ? (p.colors || []).join(', ') : '';
    $('#f-talles').value = p ? (p.sizes || []).join(', ') : '';
    $('#f-ncolores').value = p ? (p.colorCount || 0) : 0;
    $('#f-destacado').checked = p ? Boolean(p.featured) : false;
    $('#f-stock').checked = p ? p.inStock !== false : true;
    $('#f-fotos').value = '';
    $('#fotos-msg').textContent = '';
    images = ((p && p.images) || []).filter(safeImg).map((src) => ({ src, url: src, blob: null }));
    renderImages();
    updateTransferHint();
    updateColorCountBox();
    editorMsg.textContent = '';
    editor.showModal();
    $('#f-nombre').focus();
  }

  $('#nuevo').addEventListener('click', () => openEditor(null));
  $('#editor-cancelar').addEventListener('click', () => editor.close());
  editor.addEventListener('close', () => { releaseImages(); images = []; });

  // Redimensiona en el navegador antes de subir (las fotos del celular pesan mucho). Sale en WebP; si el navegador no lo soporta, en JPG.
  const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type, IMG_QUALITY));
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        let blob = await toBlob(canvas, 'image/webp');
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg');
        blob ? resolve(blob) : reject(new Error('blob'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
      img.src = url;
    });
  }

  $('#f-fotos').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const msg = $('#fotos-msg');
    msg.textContent = 'Preparando las imágenes…';
    let failed = 0;
    for (const file of files) {
      if (images.length >= MAX_IMAGES) break;
      try {
        const blob = await resizeImage(file);
        images.push({ src: URL.createObjectURL(blob), url: null, blob });
      } catch (_) {
        failed += 1;
      }
    }
    renderImages();
    msg.textContent = failed
      ? `${failed === files.length ? 'No se pudo leer' : 'No se pudieron leer algunas de'} las imágenes. Probá con otras.`
      : 'Listas: se suben al guardar.';
  });

  editorForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = $('#f-nombre').value.trim();
    const price = Number($('#f-precio').value);
    if (!name) { editorMsg.textContent = 'Escribí el nombre del producto.'; $('#f-nombre').focus(); return; }
    if (!Number.isInteger(price) || price < 1) { editorMsg.textContent = 'El precio debe ser un número entero en pesos, mayor a 0.'; $('#f-precio').focus(); return; }

    busy = true;
    const save = $('#editor-guardar');
    save.disabled = true;
    save.textContent = 'Guardando…';
    editorMsg.textContent = '';
    try {
      // Sube las imágenes nuevas (en orden) y arma la lista final de rutas
      const urls = [];
      for (const img of images) {
        if (img.url) { urls.push(img.url); continue; }
        const r = await api('/api/admin/images', { method: 'POST', body: img.blob, type: img.blob.type });
        img.url = r.url;
        urls.push(r.url);
      }
      const data = {
        name,
        category: $('#f-categoria').value,
        price,
        description: $('#f-descripcion').value.trim(),
        colors: splitList($('#f-colores').value),
        sizes: splitList($('#f-talles').value),
        colorCount: Number($('#f-ncolores').value) || 0,
        featured: $('#f-destacado').checked,
        inStock: $('#f-stock').checked,
        images: urls,
      };
      if (editing) await api(`/api/admin/products/${encodeURIComponent(editing.id)}`, { method: 'PUT', json: data });
      else await api('/api/admin/products', { method: 'POST', json: data });
      editor.close();
      say(editing ? 'Producto guardado.' : 'Producto creado.');
      await loadCatalog();
    } catch (err) {
      if (!expired(err)) editorMsg.textContent = messageOf(err);
    } finally {
      busy = false;
      save.disabled = false;
      save.textContent = 'Guardar';
    }
  });

  // ---- Eliminar ----
  function askDelete(p) {
    deleting = p;
    $('#confirm-msg').textContent = `¿Eliminar “${p.name}”? No se puede deshacer. Si solo querés que no se pueda comprar, editalo y desmarcá “Hay stock”.`;
    confirmDlg.showModal();
  }
  $('#confirm-no').addEventListener('click', () => confirmDlg.close());
  $('#confirm-si').addEventListener('click', async () => {
    if (!deleting || busy) return;
    busy = true;
    try {
      await api(`/api/admin/products/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
      confirmDlg.close();
      say('Producto eliminado.');
      await loadCatalog();
    } catch (err) {
      confirmDlg.close();
      if (!expired(err)) say(messageOf(err));
      if (err instanceof ApiError && err.status === 404) await loadCatalog();
    } finally {
      busy = false;
      deleting = null;
    }
  });

  // ---- Pestañas ----
  function selectTab(name) {
    const m = name === 'metricas';
    panel.hidden = m;
    panelMetricas.hidden = !m;
    $('#tab-productos').setAttribute('aria-pressed', String(!m));
    $('#tab-metricas').setAttribute('aria-pressed', String(m));
    if (m) loadMetricas();
  }
  $('#tab-productos').addEventListener('click', () => selectTab('productos'));
  $('#tab-metricas').addEventListener('click', () => selectTab('metricas'));
  $('#metricas-refresh').addEventListener('click', () => loadMetricas());

  // ---- Métricas (GET /api/admin/metrics; los eventos los manda metricas.js) ----
  const body = $('#metricas-cuerpo');
  const mMsg = $('#metricas-msg');
  const mLoading = $('#metricas-loading');
  let mBusy = false;

  const stat = (n, label) => { const d = el('div', 'stat'); d.append(el('b', undefined, String(n)), el('span', undefined, label)); return d; };
  function table(headers, rows, vacio) {
    if (!rows.length) return el('p', 'muted', vacio);
    const t = el('table', 'rows');
    const thead = el('thead'); const trh = el('tr');
    headers.forEach((h) => trh.append(el('th', undefined, h)));
    thead.append(trh);
    const tb = el('tbody');
    rows.forEach((r) => { const tr = el('tr'); r.forEach((c) => tr.append(el('td', undefined, String(c)))); tb.append(tr); });
    t.append(thead, tb);
    return t;
  }
  const block = (titulo, ...nodes) => { const b = el('section', 'block'); b.append(el('h3', undefined, titulo), ...nodes); return b; };
  const DEVICES = { m: 'Celular', d: 'Computadora' };

  function renderMetricas(d) {
    body.replaceChildren();

    const t = d.traffic;
    const stats = el('div', 'stats');
    stats.append(stat(t.visits, 'visitas'), stat(t.unique, 'personas distintas'), stat(t.new, 'nuevas'), stat(t.returning, 'que volvieron'));
    body.append(stats);

    const sales = el('div', 'stats');
    sales.append(stat(d.sales.orders, 'pagos aprobados'), stat(money(d.sales.total), 'cobrado con Mercado Pago'), stat(d.whatsapp, 'clics a WhatsApp'));
    body.append(sales);
    if (d.sales.mismatched) {
      body.append(el('p', 'msg', `${d.sales.mismatched} pago(s) llegaron con un monto distinto al del pedido: revisalos en Mercado Pago.`));
    }

    const max = Math.max(1, ...d.daily.map((x) => x.visits));
    const days = el('div', 'days');
    d.daily.forEach((x) => {
      const c = el('div', 'day');
      c.title = `${x.day}: ${x.visits} visitas, ${x.unique} personas`;
      const bar = el('i'); bar.style.height = `${Math.round((x.visits / max) * 100)}%`;
      c.append(bar, el('small', undefined, x.day.slice(8)));
      days.append(c);
    });
    body.append(block('Visitas por día (últimos 14 días)', days));

    const f = d.funnel;
    body.append(block('Qué hace la gente',
      table(['Paso', 'Cantidad'], [
        ['Entraron a la web (personas)', f.visited],
        ['Abrieron un producto (personas)', f.openedProduct],
        ['Agregaron al carrito (personas)', f.addedToCart],
        ['Empezaron el pago o pidieron por WhatsApp (personas)', f.startedCheckout],
        ['Pagos aprobados en Mercado Pago', f.paidOrders],
      ], 'Sin datos todavía.')));

    body.append(block('Productos',
      table(['Producto', 'Vistos', 'Al carrito', 'Vendidos'],
        d.products.map((p) => [p.name || `(${p.id})`, p.opened, p.carted, p.sold]),
        'Todavía nadie abrió un producto.')));

    const two = el('div', 'two');
    two.append(
      block('De dónde llegan', table(['Origen', 'Visitas'], d.sources.map((o) => [o.id, o.visits]), 'Sin datos.')),
      block('Dispositivos', table(['Tipo', 'Visitas'], d.devices.map((o) => [DEVICES[o.id] || o.id, o.visits]), 'Sin datos.')),
    );
    body.append(two);

    body.append(el('p', 'foot', 'Tus propias visitas desde este navegador no se cuentan. No se guarda ningún dato personal de quienes visitan la web. Para medir un enlace en particular (por ejemplo el de Instagram) agregale ?utm_source=instagram.'));
  }

  async function loadMetricas() {
    if (mBusy) return;
    mBusy = true;
    mLoading.hidden = false;
    mMsg.textContent = '';
    try {
      renderMetricas(await api('/api/admin/metrics'));
    } catch (err) {
      if (!expired(err)) mMsg.textContent = messageOf(err);
    } finally {
      mBusy = false;
      mLoading.hidden = true;
    }
  }

  // ---- Arranque: si ya hay sesión en esta pestaña, se entra directo ----
  if (token) showPanel(); else showLogin();
})();
