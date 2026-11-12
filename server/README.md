# Clotta · server de pagos

Node + Express. Crea la preferencia de **Mercado Pago Checkout Pro** con precios tomados de `../catalog.json`, confirma los pagos por webhook y sirve el sitio. La tarjeta nunca pasa por acá: el comprador paga en la página de Mercado Pago.

## Correr

```bash
cd server
npm install
copy .env.example .env      # completá MP_ACCESS_TOKEN (ver abajo)
npm start                   # http://localhost:3000
npm test                    # 71 tests, sin red
```

Sin token el sitio funciona y `/api/checkout` responde 503 `pagos_no_configurados`. El front también puede abrirse con Live Server (`:5502`): CORS ya lo permite, y el front tiene que apuntar a `http://localhost:3000`.

## Variables (`server/.env`, nunca al repo)

| Variable | Qué es |
|---|---|
| `MP_ACCESS_TOKEN` | Access Token. `TEST-...` para probar, `APP_USR-...` para cobrar. |
| `MP_WEBHOOK_SECRET` | Clave secreta del webhook. Sin ella el webhook **no verifica la firma**. |
| `PUBLIC_URL` | URL pública sin barra final (back_urls y webhook). Default `http://localhost:PORT`. |
| `PORT` / `HOST` | Default `3000` / `127.0.0.1`. En el servidor, `HOST=0.0.0.0`. |
| `ALLOWED_ORIGINS` | Orígenes CORS, separados por coma. Default Live Server `:5502`. `PUBLIC_URL` se suma sola. |
| `TRUST_PROXY` | `1` detrás de Caddy, para que el rate limit vea la IP real. |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt de la contraseña del panel (`/admin.html`). Sin ella el panel queda **deshabilitado** (el sitio y los pagos siguen andando). Ver *Panel* más abajo. |
| `ADMIN_USER` | Usuario del panel. Default `clotta`. |
| `JWT_SECRET` | Firma las sesiones del panel (12 h). Si falta se genera uno al arrancar y las sesiones caducan en cada reinicio. |

## API

| Ruta | Respuesta |
|---|---|
| `POST /api/checkout` `{items:[{id, qty, size?, color?}], buyer:{name,email,phone}, delivery:{method:'retiro'\|'envio', address?, notes?}}` | `200 {init_point, orderId}` |
| | `400 {error, code}`: `items_vacios`, `demasiados_items`, `producto_inexistente`, `sin_stock`, `cantidad_invalida`, `talle_invalido`, `color_invalido`, `json_invalido` |
| | `400 {error, code, field}`: `buyer_invalido`, `entrega_invalida`, `direccion_invalida` (p. ej. `field:"buyer.email"`, `"delivery.address.zip"`) |
| | `413 body_demasiado_grande` · `415 content_type_invalido` · `429 demasiadas_solicitudes` |
| | `503 {error:"pagos_no_configurados"}` · `502 {code:"mp_error"}` (sin detalle interno) |
| `GET /api/health` | `{ok:true, mpConfigured}` |
| `POST /api/webhook` | lo llama Mercado Pago |
| `POST /api/metrics` `{tipo, visitanteId?, productoId?, origen?, dispositivo?}` | `201` · `400 evento_invalido` · `429` (lo llama `metricas.js`) |
| `GET /`, `/catalog.json`, `/css/styles.css`, `/img/*`, `/metricas.js`, `/uploads/*`, `/admin.html` (+ `.css`/`.js`) | sitio (whitelist, ver abajo) |

Ejemplo (bash; en PowerShell usá `curl.exe` con el JSON en un archivo y `-d "@pedido.json"`). Los `id`, talles y colores salen de `catalog.json`:

```bash
curl -s http://localhost:3000/api/checkout -H 'Content-Type: application/json' -d '{
  "items": [{ "id": "blusa-rapsodia", "qty": 1, "size": "Único", "color": "Chocolate" }],
  "buyer": { "name": "Ana Pérez", "email": "ana@mail.com", "phone": "+54 351 617-6285" },
  "delivery": {
    "method": "envio",
    "address": { "street": "Av. Richieri", "number": "2872", "city": "Córdoba", "province": "Córdoba", "zip": "5000" },
    "notes": "Timbre 3"
  }
}'
# -> {"init_point":"https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=...","orderId":"<uuid>"}
# Para retiro en local: "delivery": { "method": "retiro" }
```

Reglas: cantidad entera 1–10, máx. 20 líneas, body ≤ 50 kb, `Content-Type: application/json`. Los items se validan primero, después `buyer` y `delivery`.

- `buyer`: obligatorio. `name` 2–80 caracteres, `email` válido y ≤ 120, `phone` 8–20 caracteres (solo dígitos, espacios, `+`, `-`, `(`, `)`).
- `delivery.method`: obligatorio. Con `envio` son obligatorios `address.street`, `city`, `province` y `zip` (`number` es opcional). Con `retiro` la `address` se **ignora** (ni se valida ni se guarda). `notes` es opcional, ≤ 200.
- Todo texto se recorta, colapsa espacios y rechaza `<`, `>` y caracteres de control.
- El **envío no se cobra online**: el total son solo las prendas. A Mercado Pago le pasamos `payer` (nombre, email, teléfono), `shipments.receiver_address` (cp, calle y número si es numérico) como ayuda en el panel, y `metadata` con `order_id` y `delivery_method`. Talle y color son obligatorios solo si el producto los define en `catalog.json`; `inStock: false` se rechaza. **El precio nunca viene del cliente.** Mercado Pago cobra el precio de lista; el 20 % de transferencia no pasa por acá. Cuotas limitadas a `store.installments` (3). Editar `catalog.json` se aplica sin reiniciar.

Al volver del pago, Mercado Pago redirige a `PUBLIC_URL/?pago=exito|pendiente|error&payment_id=…&status=…&external_reference=<orderId>`. **El redirect no confirma nada:** el pedido se da por pagado solo cuando el webhook lo registra.

## Probar un pago con credenciales de TEST

1. En [Mercado Pago Developers](https://www.mercadopago.com.ar/developers) > *Tus integraciones* creá una aplicación (Checkout Pro) y copiá el **Access Token de prueba** a `MP_ACCESS_TOKEN`.
2. Abrí `http://localhost:3000`, armá el carrito y tocá pagar. En la página de Mercado Pago entrá con una **cuenta de prueba compradora** (Tus integraciones > *Cuentas de prueba*) en una ventana de incógnito.
3. Tarjeta de prueba: Mastercard `5031 7557 3453 0604`, CVV `123`, vence `11/30`. Titular `APRO` + DNI `12345678` = aprobado; `OTHE` = rechazado; `CONT` = pendiente. Lista completa: [doc oficial](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/integration-test/test-purchases).

**Con `PUBLIC_URL` en localhost** la preferencia se crea igual, pero sin `notification_url` ni `auto_return` (Mercado Pago solo los acepta con https) y su doc advierte que el botón "Volver al sitio" puede mostrar "Algo ha salido mal" con back_urls locales; el pago se completa igual. Para probar el flujo entero (redirección + webhook), usá ngrok:

```bash
ngrok http 3000     # copiá la URL https que muestra
# en .env: PUBLIC_URL=https://<tu-subdominio>.ngrok-free.app   y reiniciá
```

Después, en *Tus integraciones > Webhooks* configurá `https://<ngrok>/api/webhook` (evento **Pagos**), copiá la clave secreta a `MP_WEBHOOK_SECRET` y reiniciá. El botón *Simular notificación* del panel sirve para validar la firma (el pago de prueba no existe: el server responde 200 `pago_inexistente`).

## Panel (`/admin.html`)

Mismo esquema de usuario que el panel de Bestia Parda: **un único usuario**, contraseña como **hash bcrypt** en `server/.env` y sesión con un JWT de 12 horas (límite de 10 intentos de login cada 15 min por IP). Como el hash tiene el mismo formato, se podría pegar el de Bestia Parda para usar la misma contraseña; lo mejor es generar uno propio:

```bash
cd server
node -e "console.log(require('bcryptjs').hashSync('LA_NUEVA_CONTRASEÑA', 12))"
```

Pegá el resultado en `ADMIN_PASSWORD_HASH` de `server/.env`, definí también `JWT_SECRET` (cualquier texto largo y aleatorio) y reiniciá. El usuario es `clotta` salvo que definas `ADMIN_USER`. (`ADMIN_PASSWORD` en texto plano también funciona, pero solo sirve para desarrollo.)

- **Productos:** crear, editar y eliminar tarjetas (nombre, categoría, precio, descripción, colores, talles, destacado, hay stock) y subir, quitar o reordenar sus imágenes (se redimensionan en el navegador; JPG/PNG/WebP, máx. 8 MB, hasta 8 por producto). Todo se guarda en `catalog.json`, que es la misma fuente de precios del checkout: **el precio que se carga en el panel es el que se cobra**. Se escribe de forma atómica y las ediciones corren de a una.
- **Imágenes subidas:** van a `server/data/uploads/` (nombre aleatorio) y se sirven en `/uploads/<archivo>`; en `catalog.json` queda la ruta `uploads/<archivo>`. Si se quita una imagen y ningún otro producto la usa, el archivo se borra. Abrir la web con Live Server (`:5502`) no muestra las subidas: hay que entrar por este servidor.
- **Métricas:** visitas, personas distintas, nuevas y recurrentes, visitas por día, embudo (entraron → abrieron un producto → carrito → pago), productos más vistos, agregados y vendidos, pagos aprobados y monto cobrado (de `orders.jsonl`), clics a WhatsApp, origen (`?utm_source=...` o sitio de referencia) y dispositivo, de los últimos 30 días. `metricas.js` manda los eventos sin IP ni datos personales (solo un identificador aleatorio por navegador); se conservan 90 días en `data/metrics.ndjson`. Las visitas desde el navegador donde se entró al panel no se cuentan.

API del panel (todas con `Authorization: Bearer <token>`, salvo el login): `POST /api/login` `{usuario, password}` → `{token}` · `GET /api/admin/catalog` · `POST /api/admin/products` · `PUT|DELETE /api/admin/products/:id` · `POST /api/admin/images` (cuerpo binario `image/jpeg|png|webp`) · `GET /api/admin/metrics`. Errores: `{error, code, field?}`.

## Qué queda registrado (`server/data/`, fuera del repo)

- `uploads/` y `metrics.ndjson`: imágenes subidas desde el panel y eventos anónimos de la web (ver *Panel*). Van en el backup y, si se usa Docker, en el volumen de `data/`.
- `pending.jsonl`: carrito validado al crear la preferencia (items, total, `buyer` y `delivery` completos).
- `orders.jsonl`: un renglón por pago **aprobado**, confirmado contra `GET /v1/payments/:id`, con el `buyer` y la `delivery` copiados del pedido pendiente (así se sabe a quién y adónde enviar). Idempotente por `paymentId`. Incluye `amountMatches` (monto cobrado vs. pedido) para detectar diferencias.

Estos archivos son los **únicos** lugares con datos personales. Privacidad: email, teléfono, nombre y dirección no aparecen en los logs (los mensajes de error de Mercado Pago se limpian antes de loguear) ni en las respuestas de error (que nombran el `field`, nunca repiten el valor). Los archivos se crean con permisos 600.

## Seguridad en una mirada

- Sitio servido con **whitelist** (`/`, `/index.html`, `/catalog.json`, `/css/styles.css`, `/metricas.js`, `/admin.html`, `/admin.css`, `/admin.js`, `/img/*.{webp,jpg,png,gif,avif,svg}` y `/uploads/<32 hex>.{jpg,png,webp}`). `server/.env`, los PDF y `bench/` dan 404. Si el front agrega otro archivo público en la raíz, sumarlo a `PUBLIC_FILES` en `server.js`.
- Token y secret solo por entorno; los logs los redactan. Rate limit 20/min por IP en checkout. Cabeceras básicas (`nosniff`, `frame-ancestors 'none'`, HSTS si `PUBLIC_URL` es https).
- Webhook: firma HMAC-SHA256 (`x-signature`) con comparación en tiempo constante; el payload no se usa, el estado se consulta a Mercado Pago. Ante un fallo de Mercado Pago responde 502 para que **reintente él**.

## Qué falta para producción

- **Costo de envío.** Los datos de entrega ya se piden y se guardan, pero el envío no se cobra online: hay que acordar el costo con la clienta (por WhatsApp) o sumarlo como ítem más adelante.
- **Datos personales en disco.** `server/data/` guarda nombre, email, teléfono y dirección en texto plano: definir backup, retención y quién accede.
- **Verificar la firma del webhook con una notificación real** de Mercado Pago (el manifest sigue su doc, pero solo está probado con firmas generadas localmente).
- Deploy detrás de Caddy con `HOST=0.0.0.0`, `TRUST_PROXY=1`, `PUBLIC_URL` https, token de producción y secret del webhook.
- Aviso al negocio cuando entra un pago aprobado (hoy solo queda en `orders.jsonl`).
- Reembolsos y contracargos (otros estados del pago): no se registran.
- Stock: `inStock` es manual (se cambia desde el panel); no hay descuento automático por venta.
- **`catalog.json` en producción:** el panel lo reescribe, así que tiene que vivir en un disco que persista (con Docker, montarlo como volumen junto con `server/data/`) y no pisarse con un nuevo deploy.
- El pedido se aprueba por webhook, pero la transferencia con 20 % off sigue su propio circuito (WhatsApp) y no pasa por este server.
