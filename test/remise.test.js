'use strict';
// Passage du test au réel : changement d'e-mail d'un compte, nom de l'opticien, remise à zéro de l'activité
const assert = require('assert');
const { construire, creerOrganisation } = require('../server/app');
const { migrer, pool } = require('../server/db');

(async () => {
  await migrer();
  await pool.query('TRUNCATE centrale, cles_api, dossiers, donnees, postes, sessions, comptes, organisations, envois CASCADE');
  const app = construire();
  const call = (method, url, body, tok) => app.inject({ method, url, payload: body, headers: tok ? { authorization: 'Bearer ' + tok } : {} });
  const post = (url, body, tok) => call('POST', url, body, tok).then(r => ({ code: r.statusCode, ...r.json() }));
  const get = (url, tok) => call('GET', url, undefined, tok).then(r => ({ code: r.statusCode, ...r.json() }));

  await creerOrganisation({ nom: 'FV Test', email: 'test@exemple.com', motdepasse: 'motdepasse-solide', nomAdmin: 'Nico' });
  await creerOrganisation({ nom: 'Autre', email: 'autre@x.ga', motdepasse: 'motdepasse-solide' });
  let cx = await post('/api/connexion', { email: 'test@exemple.com', motdepasse: 'motdepasse-solide' });
  const p1 = await post('/api/postes', { nom: 'Caisse', code: 'LBV1', magasin: 'Libreville' }, cx.session);
  assert.equal(p1.org.remise, 0);

  // compte : nouvel e-mail pour son propre compte, la session reste ouverte
  const { comptes, moi } = await get('/api/comptes', cx.session);
  assert.equal((await post('/api/comptes/' + moi, { email: 'pas-un-mail', role: 'admin' }, cx.session)).code, 400);
  assert.equal((await post('/api/comptes/' + moi, { email: 'autre@x.ga', role: 'admin' }, cx.session)).code, 409, 'e-mail déjà pris');
  assert.equal((await post('/api/comptes/' + moi, { email: 'Nico@FashionVision.ga', nom: 'Nicolas Puille', role: 'admin' }, cx.session)).ok, true);
  assert.equal((await post('/api/connexion', { email: 'test@exemple.com', motdepasse: 'motdepasse-solide' })).code, 401);
  assert.ok((await post('/api/connexion', { email: 'nico@fashionvision.ga', motdepasse: 'motdepasse-solide' })).session);
  assert.equal((await get('/api/comptes', cx.session)).comptes[0].nom, 'Nicolas Puille');
  assert.equal(comptes.length, 1);

  // nom de l'opticien
  assert.equal((await post('/api/organisation', { nom: 'Fashion Vision' }, cx.session)).ok, true);
  assert.equal((await get('/api/organisation', cx.session)).nom, 'Fashion Vision');

  // activité de test + paramétrage
  const PARAM = { v: { magasins: [{ nom: 'Libreville' }] } };
  let r = await post('/api/sync', { since: 0, remise: 0, changes: [
    { coll: 'parametres', id: '_', data: PARAM },
    { coll: 'clients', id: 'i:c1', data: { id: 'c1', nom: 'TEST' } },
    { coll: 'produits', id: 'i:p1', data: { id: 'p1', nom: 'OZ Lyon', stock: { Libreville: 4 } } },
    { coll: 'comptesBq', id: 'i:bq1', data: { id: 'bq1', nom: 'BGFI', soldeInit: 500000, dateInit: '2026-10-01' } },
    { coll: 'opsBq', id: 'i:o1', data: { id: 'o1', compte: 'bq1', montant: 1000 } },
    { coll: 'tplWa', id: '_', data: { v: { a: 1 } } },
  ] }, p1.jeton);
  assert.equal(r.ecrits, 6); assert.equal(r.org.nom, 'Fashion Vision');
  await post('/api/dossiers', { demandes: [{ vente: 'FA-1', magasin: 'Libreville' }] }, p1.jeton);
  const cxA = await post('/api/connexion', { email: 'autre@x.ga', motdepasse: 'motdepasse-solide' });
  const pA = await post('/api/postes', { nom: 'P', code: 'P1', magasin: 'M' }, cxA.session);
  await post('/api/sync', { since: 0, changes: [{ coll: 'clients', id: 'i:x', data: { id: 'x' } }] }, pA.jeton);

  // remise à zéro : confirmation et mot de passe obligatoires
  assert.equal((await post('/api/organisation/remise-a-zero', { confirmation: 'oui', motdepasse: 'motdepasse-solide' }, cx.session)).code, 400);
  assert.equal((await post('/api/organisation/remise-a-zero', { confirmation: 'REMISE À ZÉRO', motdepasse: 'faux' }, cx.session)).code, 401);
  const rz = await post('/api/organisation/remise-a-zero', { confirmation: 'remise à zéro', motdepasse: 'motdepasse-solide', catalogue: 'garder' }, cx.session);
  assert.equal(rz.ok, true); assert.equal(rz.remise, 1); assert.equal(rz.produits, 1);

  // le poste resté sur l'ancienne remise doit tout effacer ; ses modifications sont ignorées
  r = await post('/api/sync', { since: r.rev, remise: 0, changes: [{ coll: 'clients', id: 'i:c2', data: { id: 'c2' } }] }, p1.jeton);
  assert.equal(r.reinitialiser, true); assert.equal(r.remise, 1);
  // une fois effacé, il récupère seulement le paramétrage, les produits (stock à 0) et les comptes bancaires (sans solde de départ)
  r = await post('/api/sync', { since: 0, remise: 1, changes: [] }, p1.jeton);
  const colls = r.changes.map(c => c.coll).sort();
  assert.deepEqual(colls, ['comptesBq', 'parametres', 'produits', 'tplWa']);
  assert.deepEqual(r.changes.find(c => c.coll === 'produits').data.stock, {});
  const bq = r.changes.find(c => c.coll === 'comptesBq').data; assert.equal(bq.soldeInit, undefined); assert.equal(bq.nom, 'BGFI');
  // numéros de dossier repartis à 1
  assert.deepEqual((await post('/api/dossiers', { demandes: [{ vente: 'FA-9', magasin: 'Libreville' }] }, p1.jeton)).numeros, { 'FA-9': 1 });
  // un poste activé après la remise reçoit le bon numéro
  const p2 = await post('/api/postes', { nom: 'Caisse 2', code: 'LBV2', magasin: 'Libreville' }, cx.session);
  assert.equal(p2.org.remise, 1);
  // l'autre opticien n'est pas touché
  const rA = await post('/api/sync', { since: 0, changes: [] }, pA.jeton);
  assert.equal(rA.reinitialiser, undefined); assert.equal(rA.changes.length, 1);

  // remise avec effacement du catalogue
  const rz2 = await post('/api/organisation/remise-a-zero', { confirmation: 'REMISE A ZERO', motdepasse: 'motdepasse-solide', catalogue: 'effacer' }, cx.session);
  assert.equal(rz2.remise, 2);
  r = await post('/api/sync', { since: 0, remise: 2, changes: [] }, p1.jeton);
  assert.ok(!r.changes.some(c => c.coll === 'produits'));

  // réservé aux administrateurs
  await post('/api/comptes', { nom: 'Resp', email: 'resp@fv.ga', role: 'activation', magasins: ['Libreville'], motdepasse: 'motdepasse-solide' }, cx.session);
  const cxR = await post('/api/connexion', { email: 'resp@fv.ga', motdepasse: 'motdepasse-solide' });
  assert.equal((await post('/api/organisation/remise-a-zero', { confirmation: 'REMISE A ZERO', motdepasse: 'motdepasse-solide' }, cxR.session)).code, 403);

  console.log('remise à zéro : tous les tests passent');
  await app.close(); await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
