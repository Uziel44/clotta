'use strict';
/* Genera las páginas de la tienda a partir de index.html y catalog.json:
 *   coleccion.html   -> toda la colección
 *   <categoría>.html -> una página por categoría (denim.html, abrigos.html, ...)
 *
 * index.html es la fuente del encabezado, el pie y los diálogos: se copia tal cual y solo cambia
 * el <main> (el listado de productos) y los datos de la página (título, descripción y data-cat).
 * Los productos los dibuja app.js en el navegador.
 *
 * Uso:  node generar-paginas.js
 * Hay que volver a correrlo si se cambia el encabezado/pie de index.html o se agrega una categoría
 * en catalog.json, y commitear los .html que genera (no se editan a mano).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const template = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const { store = {}, categories = [] } = catalog;

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cuotas = store.installments ?? 3;
const descuento = Math.round((store.transferDiscount ?? 0) * 100);

function mainHtml(titulo) {
  return `<main id="main">
  <section class="block" id="coleccion" aria-labelledby="colT">
    <div class="head-line wrap"><h1 id="colT" class="display">${esc(titulo)}</h1></div>
    <div class="bar wrap">
      <p class="result-count" id="resultCount" aria-live="polite"></p>
      <label class="sort">Ordenar
        <select id="sort">
          <option value="featured">Destacados</option>
          <option value="price-asc">Menor precio</option>
          <option value="price-desc">Mayor precio</option>
          <option value="az">A-Z</option>
        </select>
      </label>
    </div>
    <div class="grid" id="grid"></div>
  </section>
</main>`;
}

function page({ file, titulo, pagina, cat, descripcion }) {
  let html = template;
  const swap = (re, to, label) => {
    if (!re.test(html)) throw new Error(`index.html no tiene ${label}: no se puede generar ${file}`);
    html = html.replace(re, () => to);
  };
  swap(/<main id="main">[\s\S]*?<\/main>/, mainHtml(titulo), '<main id="main">');
  swap(/<title>[\s\S]*?<\/title>/, `<title>${esc(titulo)} | CLOTTA</title>`, '<title>');
  swap(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(descripcion)}">`, 'meta description');
  swap(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(titulo)} | CLOTTA">`, 'og:title');
  swap(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(descripcion)}">`, 'og:description');
  swap(/<body[^>]*>/, `<body data-page="${pagina}"${cat ? ` data-cat="${esc(cat)}"` : ''}>`, '<body>');
  swap(/<head>/, '<head>\n<!-- Archivo generado por generar-paginas.js a partir de index.html: no editar a mano. -->', '<head>');
  fs.writeFileSync(path.join(ROOT, file), html);
  console.log(`  ${file}`);
}

const pago = `Pagá en hasta ${cuotas} cuotas sin interés${descuento ? ` o con ${descuento}% menos por transferencia` : ''}. Envíos a todo el país.`;
console.log('Páginas generadas:');
page({ file: 'coleccion.html', titulo: 'Toda la colección', pagina: 'coleccion', descripcion: `Toda la colección de CLOTTA: ropa y accesorios de mujer. ${pago}` });
for (const c of categories) {
  if (!/^[a-z0-9-]+$/.test(c.id)) throw new Error(`id de categoría no válido para un nombre de archivo: "${c.id}"`);
  page({ file: `${c.id}.html`, titulo: c.name, pagina: 'categoria', cat: c.id, descripcion: `${c.name} de mujer en CLOTTA. ${pago}` });
}
