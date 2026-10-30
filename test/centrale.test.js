'use strict';
// Centrale d'achat Prismea : réglage (clé gardée sur le serveur), catalogue, photo, commande, suivi
const assert = require('assert');
const http = require('http');
const { construire, creerOrganisation } = require('../server/app');
const { migrer, pool } = require('../server/db');

(async () => {
  // Fausse centrale Prismea
  const recu = [];
  const CLE = 'psm_cle_de_test_0123456789abcdef';
  const prismea = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const J = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== 'Bearer ' + CLE) return J(401, { erreur: 'Clé invalide' });
      if (req.url === '/api/catalogue') return J(200, { devise: 'EUR', montures: [{ ean: '03760313673960', etiquette: 'NEM001', marque: 'NEMEZIS', modele: 'ADONIS', coloris: 'C1', taille: '53□16 140', prix: 97.5, disponible: 3, photo: 'a'.repeat(32) }] });
      if (req.url === '/api/catalogue/photo/' + 'a'.repeat(32)) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff])); }
      if (req.url === '/api/commandes') { const c = JSON.parse(b); recu.push(c); return J(200, { ok: true, id: 'cc-dioptra-' + c.numero, etat: 'creee', reconnues: c.lignes.length, inconnues: 0 }); }
      if (req.url === '/api/commandes/statuts') { const c = JSON.parse(b); return J(200, { commandes: c.numeros.map(n => ({ numero: n, statut: 'traitee', facture: 'FA2026-0050' })) }); }
      J(404, { erreur: 'introuvable' });
    });
  });
  await new Promise(r => prismea.listen(0, r));
  const URL0 = 'http://localhost:' + prismea.address().port;

  await migrer();
  await pool.query('TRUNCATE centrale, cles_api, dossiers, donnees, postes, sessions, comptes, organisations, envois CASCADE');
  const app = construire();
  const call = (method, url, body, tok) => app.inject({ method, url, payload: body, headers: tok ? { authorization: 'Bearer ' + tok } : {} });
  const post = (url, body, tok) => call('POST', url, body, tok).then(r => ({ code: r.statusCode, ...r.json() }));
  const get = (url, tok) => call('GET', url, undefined, tok).then(r => ({ code: r.statusCode, ...(r.headers['content-type'] || '').includes('json') ? r.json() : { brut: r.rawPayload, type: r.headers['content-type'] } }));

  await creerOrganisation({ nom: 'Fashion Vision', email: 'nico@fv.ga', motdepasse: 'motdepasse-solide' });
  const cx = await post('/api/connexion', { email: 'nico@fv.ga', motdepasse: 'motdepasse-solide' });
  const p1 = await post('/api/postes', { nom: 'Caisse LBV', code: 'LBV1', magasin: 'Libreville' }, cx.session);
  await post('/api/sync', { since: 0, changes: [{ coll: 'parametres', id: '_', data: { v: { magasins: [{ nom: 'Libreville', code: 'LBV' }, { nom: 'Owendo', code: 'OWE' }] } } }] }, p1.jeton);

  // pas encore réglé
  assert.equal((await get('/api/centrale/etat', p1.jeton)).configure, false);
  assert.equal((await get('/api/centrale/catalogue', p1.jeton)).code, 400);
  // réglage : réservé à l'administrateur, clé vérifiée, jamais renvoyée en entier
  assert.equal((await post('/api/centrale', { url: URL0, cle: CLE }, p1.jeton)).code, 401, 'un poste ne peut pas régler la centrale');
  assert.equal((await post('/api/centrale', { url: URL0, cle: 'mauvaise' }, cx.session)).code, 400);
  assert.equal((await post('/api/centrale', { url: 'ftp://x', cle: CLE }, cx.session)).code, 400);
  // adresse copiée depuis la barre du navigateur (#page) : on garde seulement le site
  await post('/api/centrale', { url: URL0 + '/#parametres', cle: CLE }, cx.session);
  assert.equal((await get('/api/centrale', cx.session)).url, URL0);
  const rg = await post('/api/centrale', { url: URL0 + '/api/commandes', cle: CLE }, cx.session);
  assert.ok(/1 montures/.test(rg.test), rg.test);
  const cf = await get('/api/centrale', cx.session);
  assert.equal(cf.url, URL0); assert.ok(cf.configure); assert.ok(!cf.cle.includes('0123456789'), 'la clé complète ne sort pas');
  // catalogue et photo via le serveur
  const cat = await get('/api/centrale/catalogue', p1.jeton);
  assert.equal(cat.montures.length, 1); assert.equal(cat.montures[0].prix, 97.5);
  const ph = await get('/api/centrale/photo/' + 'a'.repeat(32), p1.jeton);
  assert.equal(ph.code, 200); assert.equal(ph.type, 'image/jpeg');
  assert.equal((await get('/api/centrale/photo/../../x', p1.jeton)).code, 404);
  // commande
  assert.equal((await post('/api/centrale/commandes', { numero: 'CMD-LBV1-X1', magasin: 'Inconnu', lignes: [{ ean: '1', qte: 1 }] }, p1.jeton)).code, 400);
  assert.equal((await post('/api/centrale/commandes', { numero: 'CMD-LBV1-X1', magasin: 'Owendo', lignes: [] }, p1.jeton)).code, 400);
  const cmd = await post('/api/centrale/commandes', { numero: 'CMD-LBV1-X1', magasin: 'Owendo', commentaire: 'urgent', lignes: [{ ean: '03760313673960', etiquette: 'NEM001', marque: 'NEMEZIS', modele: 'ADONIS', qte: 2 }] }, p1.jeton);
  assert.ok(cmd.ok, JSON.stringify(cmd));
  assert.equal(recu[0].source, 'DIOPTRA'); assert.equal(recu[0].magasin, 'Owendo'); assert.equal(recu[0].lignes[0].qte, 2); assert.equal(recu[0].commentaire, 'urgent');
  // suivi
  const st = await post('/api/centrale/statuts', { numeros: ['CMD-LBV1-X1'] }, p1.jeton);
  assert.equal(st.commandes[0].statut, 'traitee'); assert.equal(st.commandes[0].facture, 'FA2026-0050');
  // clé retirée
  await post('/api/centrale', { retirer: true }, cx.session);
  assert.equal((await get('/api/centrale/etat', p1.jeton)).configure, false);

  console.log('centrale : tous les tests passent');
  prismea.close(); await app.close(); await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
