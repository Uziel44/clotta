'use strict';

// Ventana deslizante en memoria. Suficiente para un solo proceso (un droplet);
// con varias instancias haria falta un store compartido.
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();

  function prune(current) {
    const cutoff = current - windowMs;
    for (const [key, stamps] of hits) {
      if (stamps[stamps.length - 1] <= cutoff) hits.delete(key);
    }
  }

  return {
    check(key) {
      const current = now();
      const stamps = (hits.get(key) ?? []).filter((t) => t > current - windowMs);
      if (stamps.length >= limit) {
        hits.set(key, stamps);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((stamps[0] + windowMs - current) / 1000)) };
      }
      stamps.push(current);
      hits.set(key, stamps);
      if (hits.size > 5000) prune(current);
      return { ok: true };
    },
  };
}

module.exports = { createRateLimiter };
