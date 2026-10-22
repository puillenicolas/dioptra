'use strict';
const { construire } = require('./app');
const { migrer } = require('./db');

(async () => {
  await migrer();
  const app = construire({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  try { require('./taches').demarrer(app.log); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
})().catch(e => { console.error(e); process.exit(1); });
