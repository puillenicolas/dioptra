'use strict';
const assert = require('assert');
const { construire, creerOrganisation } = require('../server/app');
const { migrer, pool } = require('../server/db');
(async () => {
  await migrer();
  await pool.query('TRUNCATE donnees, postes, sessions, comptes, organisations, envois CASCADE');
  const app = construire();
  const req = (method, url, body, tok) => app.inject({ method, url, payload: body, headers: tok ? { authorization: 'Bearer ' + tok } : {} }).then(r => ({ code: r.statusCode, ...r.json() }));
  const post = (u, b, t) => req('POST', u, b, t);
  const { org } = await creerOrganisation({ nom: 'FV', email: 'nico@fv.ga', motdepasse: 'motdepasse-solide', nomAdmin: 'Nicolas' });
  await pool.query(`INSERT INTO donnees (org_id, coll, id, data, rev) VALUES ($1,'parametres','_',$2,nextval('rev_seq'))`,
    [org.id, JSON.stringify({ v: { magasins: [{ nom: 'Libreville', actif: true }, { nom: 'Lomé', actif: true }] } })]);
  const nico = await post('/api/connexion', { email: 'nico@fv.ga', motdepasse: 'motdepasse-solide' });
  assert.equal(nico.compte.role, 'admin'); assert.equal(nico.magasins.length, 2);
  // création d'un administrateur (Laurent) et d'un compte d'activation (responsable Lomé)
  assert.equal((await post('/api/comptes', { email: 'laurent@fv.ga', nom: 'Laurent', role: 'admin', motdepasse: 'court' }, nico.session)).code, 400);
  assert.ok((await post('/api/comptes', { email: 'laurent@fv.ga', nom: 'Laurent Druost', role: 'admin', motdepasse: 'motdepasse-laurent' }, nico.session)).ok);
  assert.equal((await post('/api/comptes', { email: 'LAURENT@fv.ga', nom: 'X', role: 'admin', motdepasse: 'motdepasse-laurent' }, nico.session)).code, 409);
  assert.equal((await post('/api/comptes', { email: 'lome@fv.ga', nom: 'Resp Lomé', role: 'activation', magasins: [], motdepasse: 'motdepasse-lome1' }, nico.session)).code, 400);
  assert.ok((await post('/api/comptes', { email: 'lome@fv.ga', nom: 'Resp Lomé', role: 'activation', magasins: ['Lomé'], motdepasse: 'motdepasse-lome1' }, nico.session)).ok);
  const lst = await req('GET', '/api/comptes', undefined, nico.session);
  assert.equal(lst.comptes.length, 3);
  // le compte d'activation ne voit que Lomé et ne peut activer que là
  const lome = await post('/api/connexion', { email: 'lome@fv.ga', motdepasse: 'motdepasse-lome1' });
  assert.deepEqual(lome.magasins.map(m => m.nom), ['Lomé']);
  assert.equal((await post('/api/postes', { nom: 'Caisse', code: 'LBV9', magasin: 'Libreville' }, lome.session)).code, 403);
  const p = await post('/api/postes', { nom: 'Caisse', code: 'LOM1', magasin: 'Lomé' }, lome.session);
  assert.ok(p.jeton);
  // mais ne peut ni lister/désactiver les postes ni gérer les comptes
  assert.equal((await req('GET', '/api/postes', undefined, lome.session)).code, 403);
  assert.equal((await req('GET', '/api/comptes', undefined, lome.session)).code, 403);
  assert.equal((await post('/api/postes/' + p.poste.id + '/actif', { actif: false }, lome.session)).code, 403);
  // Laurent (admin) peut tout
  const lau = await post('/api/connexion', { email: 'laurent@fv.ga', motdepasse: 'motdepasse-laurent' });
  assert.equal((await req('GET', '/api/postes', undefined, lau.session)).postes.length, 1);
  // on ne peut pas se désactiver soi-même
  const moi = lst.comptes.find(c => c.email === 'nico@fv.ga');
  assert.equal((await post('/api/comptes/' + moi.id, { actif: false }, nico.session)).code, 400);
  // désactivation du compte Lomé : sessions coupées, connexion refusée
  const cl = lst.comptes.find(c => c.email === 'lome@fv.ga');
  assert.ok((await post('/api/comptes/' + cl.id, { actif: false }, lau.session)).ok);
  assert.equal((await post('/api/postes', { nom: 'x', code: 'LOM2', magasin: 'Lomé' }, lome.session)).code, 401);
  assert.equal((await post('/api/connexion', { email: 'lome@fv.ga', motdepasse: 'motdepasse-lome1' })).code, 401);
  // réinitialisation + changement de mot de passe
  assert.ok((await post('/api/comptes/' + cl.id, { actif: true, motdepasse: 'nouveau-mdp-lome' }, nico.session)).ok);
  const l2 = await post('/api/connexion', { email: 'lome@fv.ga', motdepasse: 'nouveau-mdp-lome' });
  assert.equal((await post('/api/moi/motdepasse', { ancien: 'faux', nouveau: 'encore-un-autre' }, l2.session)).code, 401);
  assert.ok((await post('/api/moi/motdepasse', { ancien: 'nouveau-mdp-lome', nouveau: 'encore-un-autre' }, l2.session)).ok);
  assert.ok((await post('/api/connexion', { email: 'lome@fv.ga', motdepasse: 'encore-un-autre' })).session);
  console.log('comptes : tous les tests passent');
  await app.close(); await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
