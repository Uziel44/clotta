# CLOTTA: la tienda, el panel (/admin.html), la API de pagos y las metricas en un solo contenedor.
#
# Se construye desde el docker-compose de plexipedidos (servicio "clotta", build: /home/deploy/clotta).
# El mismo servidor Node sirve la web (lista blanca de archivos), /api/* y /uploads/*; Caddy solo le
# hace reverse_proxy en clotta.plexiweb.app.
FROM node:22-alpine

WORKDIR /app/server

# Primero solo el manifest, para que Docker cachee `npm ci` mientras no cambien las dependencias.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/server.js ./
COPY server/lib ./lib

# La web: server.js la busca en la carpeta de arriba (/app). Solo lo publico (ver PUBLIC_FILES en server.js).
WORKDIR /app
COPY index.html catalog.json admin.html admin.css admin.js metricas.js ./
COPY css ./css
COPY img ./img

# data/ (uploads, pedidos, metricas y el catalog.json que edita el panel) se monta como volumen: sin el,
# cada deploy borraria los cambios hechos desde el panel. Se crea con dueño "node" para que el volumen
# nuevo herede ese permiso y el proceso pueda escribir.
WORKDIR /app/server
RUN mkdir -p data && chown node:node data
USER node

# CATALOG_PATH: el panel reescribe el catalogo, asi que vive en el volumen. La primera vez se siembra con
# el catalog.json de la imagen (/app/catalog.json).
ENV NODE_ENV=production PORT=3004 HOST=0.0.0.0 CATALOG_PATH=/app/server/data/catalog.json
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
