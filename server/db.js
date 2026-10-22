'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://dioptra:dioptra@localhost:5432/dioptra';
const ssl = /render\.com|sslmode=require/.test(url) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: url, ssl, max: 10 });

// Au démarrage, la base peut ne pas être encore prête (création, redémarrage) : on réessaie pendant 3 minutes
async function migrer() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const fin = Date.now() + 180000;
  for (let essai = 1; ; essai++) {
    try { await pool.query(sql); return; }
    catch (e) {
      const reseau = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P03'].includes(e.code);
      if (!reseau || Date.now() > fin) throw e;
      console.log(`Base de données pas encore prête (${e.code}), nouvel essai dans 5 s… (${essai})`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

module.exports = { pool, migrer, tx };
