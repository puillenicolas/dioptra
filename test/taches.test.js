'use strict';
// E-mail automatique à la clôture Z : rapport du magasin, puis récapitulatif quand tous les magasins ont clôturé
const assert = require('assert');
const { migrer, pool } = require('../server/db');
const SV = require('../server/services');
const envoyes = [];
SV.envoyerMail = async m => { envoyes.push(m); await pool.query('INSERT INTO envois (org_id, type, cle, destinataires, sujet, ok) VALUES ($1,$2,$3,$4,$5,true)', [m.orgId, m.type, m.cle, String(m.to), m.subject]); };
SV.mailConfigure = () => true;
const T = require('../server/taches');
(async () => {
  await migrer();
  await pool.query('TRUNCATE donnees, postes, sessions, comptes, organisations, envois CASCADE');
  await pool.query(`INSERT INTO organisations (id, nom) VALUES ('o1', 'Test')`);
  const j = '2026-10-24', now = new Date().toISOString(), org = { id: 'o1', nom: 'Test' };
  const P = { magasins: [{ nom: 'A', actif: true, email: 'a@x.ga' }, { nom: 'B', actif: true }], rapports: { actif: true, recap: 'dir@x.ga', magasins: { B: 'b@x.ga' } } };
  const ins = (coll, id, data) => pool.query(`INSERT INTO donnees (org_id, coll, id, data, rev) VALUES ('o1',$1,$2,$3,nextval('rev_seq'))`, [coll, id, JSON.stringify(data)]);
  await ins('parametres', '_', { v: P });
  const zA = { numero: 'Z-A1', boutique: 'A', jour: j, date: now, par: 'Nico', total: 60000, nb: 2, parMode: { 'Espèces': { n: 1, mt: 50000 }, 'Airtel Money': { n: 1, mt: 10000 } },
    sorties: [{ motif: 'Transport', montant: 5000 }], totSorties: 5000, especesTheo: 45000, especesComptees: 44000, ecart: -1000, parOrg: { CNAMGS: { n: 1, mt: 40000 } }, totPec: 40000 };
  await ins('clotures', 'n:Z-A1', zA);
  let r = await T.surCloture(org, zA, {});
  assert.equal(r.envoyes, 1, 'seulement le rapport du magasin A (B pas encore clôturé)');
  assert.ok(/^Clôture de caisse · A/.test(envoyes[0].subject) && /60 000 FCFA/.test(envoyes[0].text) && /écart -1 000/.test(envoyes[0].text), envoyes[0].text);
  assert.ok(!envoyes.some(m => /non clôtur/i.test(m.subject)), 'aucune alerte « non clôturée »');
  r = await T.surCloture(org, zA, {}); assert.equal(r.envoyes, 0, 'pas de doublon');
  const zB = { ...zA, numero: 'Z-B1', boutique: 'B', total: 20000 };
  await ins('clotures', 'n:Z-B1', zB);
  r = await T.surCloture(org, zB, {});
  assert.equal(r.envoyes, 2, 'rapport B + récapitulatif');
  const rec = envoyes.find(m => m.type === 'caisse-recap');
  assert.ok(rec && /80 000 FCFA/.test(rec.subject), rec && rec.subject);
  // désactivé : rien
  await pool.query(`UPDATE donnees SET data = $1 WHERE coll = 'parametres'`, [JSON.stringify({ v: { ...P, rapports: { ...P.rapports, actif: false } } })]);
  assert.equal((await T.surCloture(org, { ...zA, numero: 'Z-A2' }, {})).envoyes, 0);
  console.log('tâches : tous les tests passent');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
