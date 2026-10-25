'use strict';
// Tâches automatiques : e-mail de caisse quotidien (par magasin + récapitulatif)
const { pool } = require('./db');
const SV = require('./services');

const TZ = process.env.FUSEAU || 'Africa/Libreville';
const jourDe = (iso, tz = TZ) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(iso ? new Date(iso) : new Date());
const heureDe = (d = new Date(), tz = TZ) => new Intl.DateTimeFormat('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const money = n => Math.round(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ') + ' FCFA';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MODES = ['Espèces', 'Carte bancaire', 'Airtel Money', 'Moov Money'];
const adresses = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));

async function charger(orgId, colls) {
  const { rows } = await pool.query('SELECT coll, data FROM donnees WHERE org_id = $1 AND coll = ANY($2) AND NOT supprime', [orgId, colls]);
  const out = Object.fromEntries(colls.map(c => [c, []]));
  rows.forEach(r => { if (r.coll === 'parametres') out.parametres = r.data?.v || {}; else out[r.coll].push(r.data); });
  return out;
}

// Même calcul que l'écran « Caisse du jour » de l'application
function journee(D, b, j) {
  const enc = [], pecs = [];
  const take = (v, c) => {
    if (!v || v.type !== 'vente' || (v.boutique || '') !== b) return;
    (v.paiements || []).forEach(p => { if (p.date && jourDe(p.date) === j) enc.push({ date: p.date, numero: v.numero, client: c ? `${c.nom} ${c.prenom}` : (v.client || 'Anonyme'), mode: p.mode, montant: p.montant || 0 }); });
    (Array.isArray(v.pecs) ? v.pecs : v.pec ? [v.pec] : []).forEach(p => { if (jourDe(p.date || v.date) === j) pecs.push({ organisme: p.organisme, montant: p.montant || 0, numero: v.numero, client: c ? `${c.nom} ${c.prenom}` : '' }); });
  };
  D.clients.forEach(c => (c.historique || []).forEach(v => take(v, c)));
  D.ventesRapides.forEach(v => take(v, null));
  const sorties = D.mouvements.filter(m => m.boutique === b && jourDe(m.date) === j);
  const parMode = Object.fromEntries(MODES.map(k => [k, 0]));
  enc.forEach(e => { parMode[e.mode] = (parMode[e.mode] || 0) + e.montant; });
  const total = enc.reduce((a, e) => a + e.montant, 0), totSorties = sorties.reduce((a, m) => a + (m.montant || 0), 0);
  const parOrg = {}; pecs.forEach(x => { parOrg[x.organisme] = (parOrg[x.organisme] || 0) + x.montant; });
  const z = D.clotures.filter(x => x.boutique === b && x.jour === j && !x.rouverte).sort((a, c) => String(a.date).localeCompare(String(c.date))).pop() || null;
  const nbVentes = new Set(enc.map(e => e.numero)).size;
  return { b, j, enc, pecs, sorties, parMode, total, totSorties, especesTheo: (parMode['Espèces'] || 0) - totSorties, parOrg, totPec: pecs.reduce((a, x) => a + x.montant, 0), z, nbVentes };
}

const tr = (l, v, gras) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${gras ? '<b>' + l + '</b>' : l}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${gras ? '<b>' + v + '</b>' : v}</td></tr>`;
const table = rows => `<table style="border-collapse:collapse;width:100%;max-width:560px;font:14px Arial,sans-serif">${rows}</table>`;

function htmlMagasin(J) {
  const statut = J.z ? `<span style="color:#1f9d55">Clôturée à ${heureDe(new Date(J.z.date))} par ${esc(J.z.par)} (${esc(J.z.numero)})</span>`
    : `<span style="color:#dc2626"><b>Caisse NON clôturée</b> · chiffres provisoires</span>`;
  let h = `<h2 style="font:600 18px Arial,sans-serif;margin:24px 0 4px">${esc(J.b)}</h2><p style="font:14px Arial,sans-serif;margin:0 0 10px">${statut}</p>`;
  h += table(tr('Total encaissé', money(J.total), true) + MODES.map(m => tr(m, money(J.parMode[m]))).join('')
    + Object.keys(J.parMode).filter(m => !MODES.includes(m) && J.parMode[m]).map(m => tr(esc(m), money(J.parMode[m]))).join('')
    + tr('Nombre de ventes encaissées', String(J.nbVentes))
    + tr('Sorties d\'espèces', '− ' + money(J.totSorties))
    + tr('Espèces théoriques', money(J.especesTheo))
    + (J.z ? tr('Espèces comptées', money(J.z.especesComptees)) + tr('Écart', `<span style="color:${J.z.ecart ? '#dc2626' : '#1f9d55'}">${J.z.ecart > 0 ? '+' : ''}${money(J.z.ecart)}</span>`, true) : '')
    + tr('Prises en charge du jour (hors caisse)', money(J.totPec), true)
    + Object.entries(J.parOrg).map(([o, m]) => tr('&nbsp;&nbsp;' + esc(o), money(m))).join(''));
  if (J.sorties.length) h += `<p style="font:13px Arial,sans-serif;margin:10px 0 4px"><b>Sorties</b></p>` + table(J.sorties.map(m => tr(esc(`${m.motif || ''}${m.commentaire ? ' · ' + m.commentaire : ''}`), money(m.montant))).join(''));
  if (J.z && J.z.commentaire) h += `<p style="font:13px Arial,sans-serif">Commentaire de clôture : ${esc(J.z.commentaire)}</p>`;
  return h;
}
const enveloppe = (titre, corps) => `<div style="font:14px Arial,sans-serif;color:#111;max-width:620px">
  <p style="font:600 13px Arial,sans-serif;letter-spacing:.08em;color:#6b6b6b;margin:0">DIOPTRA</p><h1 style="font:600 22px Arial,sans-serif;margin:4px 0 0">${titre}</h1>${corps}
  <p style="font:12px Arial,sans-serif;color:#6b6b6b;margin-top:28px">E-mail automatique envoyé par DIOPTRA. Pour modifier les destinataires : Paramètres › Général › E-mail de caisse.</p></div>`;
const texte = J => `${J.b} : ${J.z ? 'clôturée' : 'NON CLÔTURÉE'} · encaissé ${money(J.total)} · espèces théoriques ${money(J.especesTheo)}${J.z ? ` · écart ${money(J.z.ecart)}` : ''} · PEC ${money(J.totPec)}`;

async function dejaEnvoye(orgId, type, cle) {
  const { rows } = await pool.query('SELECT 1 FROM envois WHERE org_id = $1 AND type = $2 AND cle = $3 AND ok LIMIT 1', [orgId, type, cle]);
  return rows.length > 0;
}

/** Envoie les rapports d'un opticien pour un jour donné (si pas déjà fait). */
async function rapportsOrg(org, j, force = false) {
  const D = await charger(org.id, ['parametres', 'clients', 'ventesRapides', 'mouvements', 'clotures']);
  const P = D.parametres || {}, R = P.rapports || {};
  if (!force && !R.actif) return { envoyes: 0 };
  const mags = (P.magasins || []).filter(m => m.actif !== false);
  const J = mags.map(m => journee(D, m.nom, j));
  const dateTxt = new Date(j + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  let envoyes = 0;
  for (let i = 0; i < mags.length; i++) {
    const m = mags[i], to = adresses((R.magasins || {})[m.nom] || m.email);
    if (!to.length) continue;
    // un essai (force) n'empêche pas les envois automatiques
    const cle = force ? null : `${j}|${m.nom}`;
    if (cle && await dejaEnvoye(org.id, 'caisse', cle)) continue;
    await SV.envoyerMail({ orgId: org.id, orgNom: org.nom, type: force ? 'caisse-essai' : 'caisse', cle, to,
      subject: `${force ? '[Essai] ' : ''}${J[i].z ? 'Caisse' : '⚠ Caisse non clôturée'} · ${m.nom} · ${dateTxt}`,
      html: enveloppe(`Caisse du ${dateTxt}`, htmlMagasin(J[i])), text: texte(J[i]) });
    envoyes++;
  }
  const recap = adresses(R.recap);
  if (recap.length && (force || !(await dejaEnvoye(org.id, 'caisse-recap', j)))) {
    const nonClos = J.filter(x => !x.z);
    const tot = J.reduce((a, x) => a + x.total, 0), totPec = J.reduce((a, x) => a + x.totPec, 0);
    const resume = `<p style="margin:12px 0">${nonClos.length ? `<b style="color:#dc2626">${nonClos.length} magasin${nonClos.length > 1 ? 's' : ''} non clôturé${nonClos.length > 1 ? 's' : ''} : ${nonClos.map(x => esc(x.b)).join(', ')}</b>` : '<span style="color:#1f9d55">Tous les magasins sont clôturés.</span>'}</p>`
      + table(J.map(x => tr(`${esc(x.b)}${x.z ? '' : ' <span style="color:#dc2626">· non clôturée</span>'}`, money(x.total))).join('') + tr('Total encaissé tous magasins', money(tot), true) + tr('Prises en charge du jour', money(totPec)))
      + J.map(htmlMagasin).join('');
    await SV.envoyerMail({ orgId: org.id, orgNom: org.nom, type: force ? 'caisse-essai' : 'caisse-recap', cle: force ? null : j, to: recap,
      subject: `${force ? '[Essai] ' : ''}${nonClos.length ? '⚠ ' : ''}Récapitulatif des caisses · ${dateTxt} · ${money(tot)}`,
      html: enveloppe(`Récapitulatif des caisses du ${dateTxt}`, resume), text: J.map(texte).join('\n') });
    envoyes++;
  }
  return { envoyes };
}

// Le rapport d'une clôture Z se construit à partir des chiffres enregistrés dans la clôture elle-même
function depuisZ(z) {
  const num = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, typeof v === 'number' ? v : (v && v.mt) || 0]));
  return { b: z.boutique, j: z.jour, z, total: z.total || 0, parMode: num(z.parMode), nbVentes: z.nb || 0, sorties: z.sorties || [],
    totSorties: z.totSorties || 0, especesTheo: z.especesTheo || 0, parOrg: num(z.parOrg), totPec: z.totPec || 0 };
}
const dateLongue = j => new Date(j + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Envoi automatique au moment d'une clôture Z (appelé quand le serveur reçoit une nouvelle clôture) :
 * rapport du magasin, puis récapitulatif de tous les magasins quand le dernier magasin du jour a clôturé.
 */
async function surCloture(org, z, log = console) {
  if (!SV.mailConfigure() || !z || !z.numero || z.rouverte) return { envoyes: 0 };
  const D = await charger(org.id, ['parametres', 'clotures']);
  const P = D.parametres || {}, R = P.rapports || {};
  if (!R.actif) return { envoyes: 0 };
  const m = (P.magasins || []).find(x => x.nom === z.boutique) || { nom: z.boutique };
  const J = depuisZ(z), dateTxt = dateLongue(z.jour);
  let envoyes = 0;
  const to = adresses((R.magasins || {})[m.nom] || m.email);
  if (to.length && !(await dejaEnvoye(org.id, 'caisse', 'Z:' + z.numero))) {
    await SV.envoyerMail({ orgId: org.id, orgNom: org.nom, type: 'caisse', cle: 'Z:' + z.numero, to,
      subject: `Clôture de caisse · ${m.nom} · ${dateTxt} · ${money(J.total)}`,
      html: enveloppe(`Clôture de caisse du ${dateTxt}`, htmlMagasin(J)), text: texte(J) });
    envoyes++;
  }
  // récapitulatif : seulement quand tous les magasins actifs ont clôturé ce jour-là
  const recap = adresses(R.recap), mags = (P.magasins || []).filter(x => x.actif !== false);
  if (recap.length && mags.length) {
    const derniereZ = b => D.clotures.filter(x => x.boutique === b && x.jour === z.jour && !x.rouverte).sort((a, c) => String(a.date).localeCompare(String(c.date))).pop();
    const Z = mags.map(x => derniereZ(x.nom));
    if (Z.every(Boolean) && !(await dejaEnvoye(org.id, 'caisse-recap', z.jour))) {
      const L = Z.map(depuisZ), tot = L.reduce((a, x) => a + x.total, 0), totPec = L.reduce((a, x) => a + x.totPec, 0);
      const corps = `<p style="margin:12px 0;color:#1f9d55">Tous les magasins ont clôturé leur caisse.</p>`
        + table(L.map(x => tr(esc(x.b), money(x.total))).join('') + tr('Total encaissé tous magasins', money(tot), true) + tr('Prises en charge du jour', money(totPec)))
        + L.map(htmlMagasin).join('');
      await SV.envoyerMail({ orgId: org.id, orgNom: org.nom, type: 'caisse-recap', cle: z.jour, to: recap,
        subject: `Récapitulatif des caisses · ${dateTxt} · ${money(tot)}`,
        html: enveloppe(`Récapitulatif des caisses du ${dateTxt}`, corps), text: L.map(texte).join('\n') });
      envoyes++;
    }
  }
  if (envoyes && log.info) log.info({ org: org.nom, z: z.numero, envoyes }, 'rapport de clôture envoyé');
  return { envoyes };
}

// Plus d'envoi programmé : les rapports partent à chaque clôture (voir surCloture)
function demarrer() {}

module.exports = { demarrer, rapportsOrg, journee, jourDe, surCloture, depuisZ };
