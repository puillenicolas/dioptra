'use strict';
const assert = require('assert');
const { construire, creerOrganisation } = require('../server/app');
const { migrer, pool } = require('../server/db');
(async () => {
  await migrer();
  await pool.query('TRUNCATE centrale, cles_api, dossiers, donnees, postes, sessions, comptes, organisations, envois CASCADE');
  const app = construire();
  const post = (url, body, tok) => app.inject({ method: 'POST', url, payload: body, headers: tok ? { authorization: 'Bearer ' + tok } : {} }).then(r => ({ code: r.statusCode, ...r.json() }));
  await creerOrganisation({ nom: 'Fashion Vision', email: 'nico@fv.ga', motdepasse: 'motdepasse-solide', nomAdmin: 'Nicolas' });
  await creerOrganisation({ nom: 'Autre Optique', email: 'autre@x.ga', motdepasse: 'motdepasse-solide' });
  assert.equal((await post('/api/connexion', { email: 'nico@fv.ga', motdepasse: 'faux' })).code, 401);
  const cx = await post('/api/connexion', { email: 'NICO@fv.ga', motdepasse: 'motdepasse-solide' });
  assert.ok(cx.session); assert.deepEqual(cx.magasins, []);
  const p1 = await post('/api/postes', { nom: 'Caisse LBV', code: 'lbv1', magasin: 'Libreville' }, cx.session);
  const p2 = await post('/api/postes', { nom: 'Caisse AKA', code: 'AKA1', magasin: 'Akanda' }, cx.session);
  assert.equal(p1.poste.num, 1); assert.equal(p2.poste.num, 2); assert.equal(p1.poste.code, 'LBV1');
  assert.equal((await post('/api/postes', { nom: 'x', code: 'LBV1' }, cx.session)).code, 409);
  // poste 1 crée un client
  const c0 = { id: 'c1', nom: 'MBA', historique: [] };
  let r1 = await post('/api/sync', { since: 0, changes: [{ coll: 'clients', id: 'i:c1', data: c0 }, { coll: 'parametres', id: '_', data: { v: { magasins: [{ nom: 'Libreville', code: 'LBV' }] } } }] }, p1.jeton);
  assert.equal(r1.ecrits, 2); assert.equal(r1.changes.length, 2);
  // poste 2 récupère, puis les deux ajoutent une vente hors ligne
  let r2 = await post('/api/sync', { since: 0, changes: [] }, p2.jeton);
  assert.equal(r2.changes.length, 2);
  const a = { ...c0, historique: [{ numero: 'FA-LBV1-2026-0001', net: 10 }] };
  const b = { ...c0, tel: '077', historique: [{ numero: 'FA-AKA1-2026-0001', net: 20 }] };
  r1 = await post('/api/sync', { since: r1.rev, changes: [{ coll: 'clients', id: 'i:c1', data: a, base: c0 }] }, p1.jeton);
  r2 = await post('/api/sync', { since: r2.rev, changes: [{ coll: 'clients', id: 'i:c1', data: b, base: c0 }] }, p2.jeton);
  const fus = r2.changes.find(c => c.id === 'i:c1').data;
  assert.equal(fus.historique.length, 2); assert.equal(fus.tel, '077');
  // poste 1 reçoit la version fusionnée
  r1 = await post('/api/sync', { since: r1.rev, changes: [] }, p1.jeton);
  assert.equal(r1.changes.find(c => c.id === 'i:c1').data.historique.length, 2);
  // renvoi identique : rien écrit mais écho renvoyé
  const r3 = await post('/api/sync', { since: r1.rev, changes: [{ coll: 'clients', id: 'i:c1', data: fus, base: fus }] }, p1.jeton);
  assert.equal(r3.ecrits, 0); assert.equal(r3.changes.length, 1);
  // isolation entre opticiens
  const cx2 = await post('/api/connexion', { email: 'autre@x.ga', motdepasse: 'motdepasse-solide' });
  const q = await post('/api/postes', { nom: 'Poste', code: 'LBV1' }, cx2.session);
  assert.ok(q.jeton, 'même code autorisé chez un autre opticien');
  const r4 = await post('/api/sync', { since: 0, changes: [] }, q.jeton);
  assert.equal(r4.changes.length, 0);
  // magasins visibles à la connexion
  assert.deepEqual((await post('/api/connexion', { email: 'nico@fv.ga', motdepasse: 'motdepasse-solide' })).magasins, [{ nom: 'Libreville', code: 'LBV' }]);
  // numéros de dossier : un compteur par magasin, demande rejouable
  let dn = await post('/api/dossiers', { demandes: [{ vente: 'FA-LBV1-2026-0001', magasin: 'Libreville' }, { vente: 'FA-LBV1-2026-0002', magasin: 'Libreville' }, { vente: 'FA-AKA1-2026-0001', magasin: 'Akanda' }] }, p1.jeton);
  assert.deepEqual(dn.numeros, { 'FA-LBV1-2026-0001': 1, 'FA-LBV1-2026-0002': 2, 'FA-AKA1-2026-0001': 1 });
  dn = await post('/api/dossiers', { demandes: [{ vente: 'FA-AKA1-2026-0002', magasin: 'Libreville' }, { vente: 'FA-LBV1-2026-0001', magasin: 'Libreville' }] }, p2.jeton);
  assert.deepEqual(dn.numeros, { 'FA-AKA1-2026-0002': 3, 'FA-LBV1-2026-0001': 1 });
  assert.equal((await post('/api/dossiers', { demandes: [{ vente: '' }] }, p1.jeton)).code, 400);
  assert.deepEqual((await post('/api/dossiers', { demandes: [{ vente: 'FA-LBV1-2026-0001', magasin: 'Libreville' }] }, q.jeton)).numeros, { 'FA-LBV1-2026-0001': 1 }, 'compteur séparé par opticien');
  // intégration Prismea : clé d'API, envoi d'un bon de livraison, idempotence, refus après réception
  const k = await post('/api/cles', { nom: 'Prismea' }, cx.session);
  assert.ok(k.cle && k.cle.startsWith('dpt_'));
  assert.equal((await post('/api/livraisons', { numero: 'X', lignes: [{ ean: '1', qte: 1 }] }, 'mauvaise')).code, 401);
  const BL = { source: 'Prismea', numero: 'FA2026-0042', date: '2026-10-29', devise: 'EUR', magasin: 'Libreville', lignes: [{ ean: '8053672000001', etiquette: 'OZO-001', marque: 'OZ', modele: 'Lyon', coloris: 'Noir', taille: '52□18 140', qte: 2, pu: 35.5 }] };
  let lv = await post('/api/livraisons', BL, k.cle);
  assert.equal(lv.etat, 'creee'); assert.equal(lv.articles, 2);
  assert.equal((await post('/api/livraisons', BL, k.cle)).etat, 'maj');
  assert.equal((await post('/api/livraisons', { numero: 'Y', lignes: [{ marque: 'OZ' }] }, k.cle)).code, 400);
  let rs = await post('/api/sync', { since: 0, changes: [] }, p1.jeton);
  const liv = rs.changes.find(c => c.coll === 'livraisons');
  assert.equal(liv.data.lignes[0].pu, 35.5); assert.equal(liv.data.total, 71); assert.equal(liv.data.statut, 'À réceptionner');
  await post('/api/sync', { since: rs.rev, changes: [{ coll: 'livraisons', id: liv.id, data: { ...liv.data, statut: 'Réceptionnée' }, base: liv.data }] }, p1.jeton);
  assert.equal((await post('/api/livraisons', BL, k.cle)).code, 409);
  assert.equal((await post('/api/livraisons', BL, q.jeton)).code, 401, 'un jeton de poste n\'est pas une clé d\'intégration');
  // poste désactivé
  await post('/api/postes/' + p2.poste.id + '/actif', { actif: false }, cx.session);
  assert.equal((await post('/api/sync', { since: 0 }, p2.jeton)).code, 401);
  // suppression
  const r5 = await post('/api/sync', { since: 0, changes: [{ coll: 'clients', id: 'i:c1', deleted: true, base: fus }] }, p1.jeton);
  assert.ok(r5.changes.find(c => c.id === 'i:c1').deleted);
  console.log('serveur : tous les tests passent');
  await app.close(); await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
