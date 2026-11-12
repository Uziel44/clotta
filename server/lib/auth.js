'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const BCRYPT_HASH = /^\$2[abxy]\$\d{2}\$.{53}$/;
const JWT_EXPIRES_IN = '12h';

// Mismo esquema que el panel de Bestia Parda: un unico usuario, contrasena como hash bcrypt
// en server/.env y sesion con un JWT de 12 horas. Si no hay contrasena configurada el panel
// queda deshabilitado, pero el sitio y los pagos siguen funcionando.
function createAuth({ env = process.env, logger = {} } = {}) {
  const username = (env.ADMIN_USER || 'clotta').trim().toLowerCase();
  let passwordHash = (env.ADMIN_PASSWORD_HASH || '').trim();

  if (passwordHash && !BCRYPT_HASH.test(passwordHash)) {
    logger.error?.('admin.hash_invalido', { detail: 'ADMIN_PASSWORD_HASH no parece un hash bcrypt valido: el panel queda deshabilitado' });
    passwordHash = '';
  } else if (!passwordHash && env.ADMIN_PASSWORD) {
    passwordHash = bcrypt.hashSync(env.ADMIN_PASSWORD, 10);
    logger.warn?.('admin.password_en_texto_plano', { detail: 'ADMIN_PASSWORD en texto plano (se hashea al arrancar). En produccion usa ADMIN_PASSWORD_HASH' });
  }

  const enabled = Boolean(passwordHash);
  if (!enabled) logger.warn?.('admin.sin_password', { detail: 'ADMIN_PASSWORD_HASH no esta configurado: el panel /admin.html esta deshabilitado' });

  let secret = env.JWT_SECRET || '';
  if (enabled && !secret) {
    secret = crypto.randomBytes(48).toString('hex');
    logger.warn?.('admin.sin_jwt_secret', { detail: 'falta JWT_SECRET: las sesiones del panel caducan en cada reinicio' });
  }

  return {
    enabled,

    // Devuelve un token o null. Siempre compara con bcrypt, aunque el usuario no coincida,
    // para que el tiempo de respuesta no delate si el usuario existe.
    async login(user, password) {
      if (!enabled || typeof user !== 'string' || typeof password !== 'string' || password.length > 200) return null;
      const passwordOk = await bcrypt.compare(password, passwordHash);
      const userOk = user.trim().toLowerCase() === username;
      if (!(userOk && passwordOk)) return null;
      return jwt.sign({ sub: username }, secret, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
    },

    isValidRequest(req) {
      const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
      if (!enabled || !match) return false;
      try {
        return jwt.verify(match[1], secret, { algorithms: ['HS256'] }).sub === username;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createAuth };
