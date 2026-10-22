#!/usr/bin/env node
'use strict';
// Crée un opticien (organisation) et son premier compte administrateur.
// Usage : node scripts/creer-opticien.js "Fashion Vision" admin@exemple.com "MotDePasseSolide" "Nicolas Puille"
const { migrer, pool } = require('../server/db');
const { creerOrganisation } = require('../server/app');

(async () => {
  const [nom, email, motdepasse, nomAdmin] = process.argv.slice(2);
  if (!nom || !email || !motdepasse) {
    console.error('Usage : node scripts/creer-opticien.js "Nom de l\'opticien" email "mot de passe" ["Nom de l\'administrateur"]');
    process.exit(1);
  }
  if (motdepasse.length < 10) { console.error('Le mot de passe doit faire au moins 10 caractères.'); process.exit(1); }
  await migrer();
  const r = await creerOrganisation({ nom, email, motdepasse, nomAdmin });
  console.log(`Opticien créé : ${r.org.nom} (${r.org.id}) · compte administrateur : ${r.compte.email}`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
