'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Registro en archivos JSONL (un pedido por linea). Alcanza para una tienda chica;
// si el volumen crece, esto se reemplaza por una tabla sin tocar server.js.
//   pending.jsonl -> carrito validado al crear la preferencia (items, total, comprador)
//   orders.jsonl  -> pagos aprobados confirmados contra la API de Mercado Pago
function createOrderStore(dir) {
  const pendingFile = path.join(dir, 'pending.jsonl');
  const ordersFile = path.join(dir, 'orders.jsonl');
  let chain = Promise.resolve();
  let paidIds = null;

  // Serializa las escrituras: dos webhooks del mismo pago no pueden registrarlo dos veces.
  function locked(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  async function readRows(file) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // linea a medio escribir: se ignora
      }
    }
    return rows;
  }

  async function append(file, row) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  return {
    savePending: (order) => locked(() => append(pendingFile, order)),

    async findPending(orderId) {
      const rows = await readRows(pendingFile);
      return rows.findLast((row) => row.orderId === orderId) ?? null;
    },

    recordApproved: (entry) =>
      locked(async () => {
        if (!paidIds) paidIds = new Set((await readRows(ordersFile)).map((row) => String(row.paymentId)));
        const key = String(entry.paymentId);
        if (paidIds.has(key)) return { recorded: false };
        await append(ordersFile, entry);
        paidIds.add(key);
        return { recorded: true };
      }),
  };
}

module.exports = { createOrderStore };
