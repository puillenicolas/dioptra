'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://dioptra:dioptra@localhost:5432/dioptra';
const ssl = /render\.com|sslmode=require/.test(url) || process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: url, ssl, max: 10 });

async function migrer() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
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
