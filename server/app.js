'use strict';
const path = require('path');
const Fastify = require('fastify');
const { pool, tx } = require('./db');
const S = require('./securite');
const M = require('../shared/merge');

const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const LIMITE_PULL = 2000;

function construire(opts = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 60 * 1024 * 1024, trustProxy: true });

  // ---------- Limitation des tentatives de connexion ----------
  const essais = new Map();
  function limiter(cle) {
    const now = Date.now(), e = essais.get(cle) || { n: 0, t: now };
    if (now - e.t > 15 * 60 * 1000) { e.n = 0; e.t = now; }
    e.n++; essais.set(cle, e);
    return e.n > 10;
  }

  const err = (rep, code, msg) => rep.code(code).send({ erreur: msg });

  // ---------- Authentification ----------
  async function poste(req, rep) {
    const j = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!j) return err(rep, 401, 'Poste non activé.');
    const { rows } = await pool.query(
      `SELECT p.*, o.nom AS org_nom, o.actif AS org_actif FROM postes p JOIN organisations o ON o.id = p.org_id WHERE p.jeton_hash = $1`, [S.hacherJeton(j)]);
    const p = rows[0];
    if (!p || !p.actif || !p.org_actif) return err(rep, 401, 'Ce poste a été désactivé. Demandez à l\'administrateur de le réactiver.');
    req.poste = p;
    pool.query('UPDATE postes SET vu_le = now() WHERE id = $1', [p.id]).catch(() => {});
  }
  async function session(req, rep) {
    const j = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { rows } = await pool.query(
      `SELECT c.*, o.nom AS org_nom FROM sessions s JOIN comptes c ON c.id = s.compte_id JOIN organisations o ON o.id = c.org_id
       WHERE s.jeton_hash = $1 AND s.expire_le > now() AND c.actif AND o.actif`, [S.hacherJeton(j || '-')]);
    if (!rows[0]) return err(rep, 401, 'Session expirée, reconnectez-vous.');
    req.compte = rows[0];
  }
  async function sessionAdmin(req, rep) {
    await session(req, rep);
    if (rep.sent) return;
    if (req.compte.role !== 'admin') return err(rep, 403, 'Réservé aux comptes administrateurs.');
  }
  const compteInfo = c => ({ id: c.id, nom: c.nom, email: c.email, role: c.role, magasins: c.magasins || [] });
  // magasins qu'un compte peut utiliser pour activer un poste
  const magasinsCompte = (c, mags) => c.role === 'admin' ? mags : mags.filter(m => (c.magasins || []).includes(m.nom));

  async function magasinsDe(orgId) {
    const { rows } = await pool.query(`SELECT data FROM donnees WHERE org_id = $1 AND coll = 'parametres' AND id = '_' AND NOT supprime`, [orgId]);
    const P = rows[0]?.data?.v;
    return Array.isArray(P?.magasins) ? P.magasins.filter(m => m.actif !== false).map(m => ({ nom: m.nom, code: m.code || '' })) : [];
  }

  // Connexion d'un administrateur (pour activer un poste ou gérer les postes)
  app.post('/api/connexion', async (req, rep) => {
    const { email, motdepasse } = req.body || {};
    if (!email || !motdepasse) return err(rep, 400, 'E-mail et mot de passe obligatoires.');
    if (limiter(req.ip + '|' + String(email).toLowerCase())) return err(rep, 429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    const { rows } = await pool.query(
      `SELECT c.*, o.nom AS org_nom, o.actif AS org_actif FROM comptes c JOIN organisations o ON o.id = c.org_id WHERE lower(c.email) = lower($1)`, [email]);
    const c = rows[0];
    if (!c || !c.actif || !c.org_actif || !S.verifierMdp(motdepasse, c.mdp_hash)) return err(rep, 401, 'E-mail ou mot de passe incorrect.');
    const jeton = S.nouveauJeton();
    await pool.query(`INSERT INTO sessions (jeton_hash, compte_id, expire_le) VALUES ($1, $2, now() + interval '2 hours')`, [S.hacherJeton(jeton), c.id]);
    const { rows: postes } = await pool.query(`SELECT id, num, code, nom, magasin, actif, vu_le, cree_le FROM postes WHERE org_id = $1 ORDER BY num`, [c.org_id]);
    const mags = await magasinsDe(c.org_id), autorises = magasinsCompte(c, mags);
    if (c.role !== 'admin' && !autorises.length) return err(rep, 403, 'Aucun magasin n\'est attribué à ce compte. Demandez à l\'administrateur de vous en attribuer un.');
    return { session: jeton, org: { id: c.org_id, nom: c.org_nom }, compte: compteInfo(c), magasins: autorises,
      postes: c.role === 'admin' ? postes : postes.map(p => ({ code: p.code })) };
  });

  // Activation d'un nouveau poste (appareil)
  app.post('/api/postes', { preHandler: session }, async (req, rep) => {
    const b = req.body || {};
    const nom = String(b.nom || '').trim().slice(0, 60), magasin = String(b.magasin || '').trim().slice(0, 120);
    const code = String(b.code || '').trim().toUpperCase();
    if (!nom) return err(rep, 400, 'Donnez un nom au poste (ex. Caisse Libreville).');
    if (!/^[A-Z0-9]{2,6}$/.test(code)) return err(rep, 400, 'Le code du poste doit faire 2 à 6 lettres ou chiffres (ex. LBV1).');
    if (req.compte.role !== 'admin') {
      const ok = magasinsCompte(req.compte, await magasinsDe(req.compte.org_id)).some(m => m.nom === magasin);
      if (!ok) return err(rep, 403, 'Ce compte ne peut pas activer de poste dans ce magasin.');
    }
    const jeton = S.nouveauJeton(), id = S.nouvelId('pt_');
    try {
      const p = await tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.compte.org_id]);
        const { rows: [{ n }] } = await c.query('SELECT coalesce(max(num), 0) + 1 AS n FROM postes WHERE org_id = $1', [req.compte.org_id]);
        const { rows } = await c.query(
          `INSERT INTO postes (id, org_id, num, code, nom, magasin, jeton_hash, cree_par) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, num, code, nom, magasin`, [id, req.compte.org_id, n, code, nom, magasin, S.hacherJeton(jeton), req.compte.email]);
        return rows[0];
      });
      return { jeton, poste: p, org: { id: req.compte.org_id, nom: req.compte.org_nom }, compte: compteInfo(req.compte) };
    } catch (e) {
      if (e.code === '23505') return err(rep, 409, `Le code ${code} est déjà utilisé par un autre poste.`);
      throw e;
    }
  });

  app.get('/api/postes', { preHandler: sessionAdmin }, async req => {
    const { rows } = await pool.query(`SELECT id, num, code, nom, magasin, actif, vu_le, cree_le FROM postes WHERE org_id = $1 ORDER BY num`, [req.compte.org_id]);
    return { postes: rows };
  });
  app.post('/api/postes/:id/actif', { preHandler: sessionAdmin }, async (req, rep) => {
    const { rowCount } = await pool.query('UPDATE postes SET actif = $1 WHERE id = $2 AND org_id = $3', [!!req.body?.actif, req.params.id, req.compte.org_id]);
    if (!rowCount) return err(rep, 404, 'Poste introuvable.');
    return { ok: true };
  });

  // ---------- Comptes d'accès (administrateurs et comptes d'activation) ----------
  const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
  app.get('/api/comptes', { preHandler: sessionAdmin }, async req => {
    const { rows } = await pool.query('SELECT id, nom, email, role, magasins, actif, cree_le FROM comptes WHERE org_id = $1 ORDER BY role, nom', [req.compte.org_id]);
    return { comptes: rows, moi: req.compte.id };
  });
  app.post('/api/comptes', { preHandler: sessionAdmin }, async (req, rep) => {
    const { email, nom, role = 'activation', magasins = [], motdepasse } = req.body || {};
    if (!emailOk(email) || !String(nom || '').trim()) return err(rep, 400, 'Nom et e-mail valides obligatoires.');
    if (!['admin', 'activation'].includes(role)) return err(rep, 400, 'Type de compte invalide.');
    if (String(motdepasse || '').length < 10) return err(rep, 400, 'Le mot de passe doit faire au moins 10 caractères.');
    if (role === 'activation' && (!Array.isArray(magasins) || !magasins.length)) return err(rep, 400, 'Choisissez au moins un magasin pour ce compte.');
    try {
      const id = S.nouvelId('cpt_');
      await pool.query('INSERT INTO comptes (id, org_id, email, nom, mdp_hash, role, magasins) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, req.compte.org_id, String(email).trim().toLowerCase(), String(nom).trim().slice(0, 80), S.hacherMdp(motdepasse), role, JSON.stringify(role === 'admin' ? [] : magasins.map(String))]);
      return { ok: true, id };
    } catch (e) { if (e.code === '23505') return err(rep, 409, 'Cette adresse e-mail est déjà utilisée par un autre compte.'); throw e; }
  });
  app.post('/api/comptes/:id', { preHandler: sessionAdmin }, async (req, rep) => {
    const b = req.body || {}, id = req.params.id;
    const { rows: [c] } = await pool.query('SELECT * FROM comptes WHERE id = $1 AND org_id = $2', [id, req.compte.org_id]);
    if (!c) return err(rep, 404, 'Compte introuvable.');
    const role = b.role || c.role, actif = b.actif != null ? !!b.actif : c.actif, magasins = Array.isArray(b.magasins) ? b.magasins.map(String) : c.magasins;
    if (id === req.compte.id && (!actif || role !== 'admin')) return err(rep, 400, 'Vous ne pouvez pas désactiver votre propre compte ni retirer vos droits d\'administrateur.');
    if (role === 'activation' && !magasins.length) return err(rep, 400, 'Choisissez au moins un magasin pour ce compte.');
    if (b.motdepasse != null && String(b.motdepasse).length < 10) return err(rep, 400, 'Le mot de passe doit faire au moins 10 caractères.');
    await pool.query('UPDATE comptes SET role = $1, actif = $2, magasins = $3' + (b.motdepasse ? ', mdp_hash = $5' : '') + ' WHERE id = $4',
      [role, actif, JSON.stringify(role === 'admin' ? [] : magasins), id, ...(b.motdepasse ? [S.hacherMdp(b.motdepasse)] : [])]);
    if (!actif || b.motdepasse) await pool.query('DELETE FROM sessions WHERE compte_id = $1', [id]);
    return { ok: true };
  });
  // changer son propre mot de passe
  app.post('/api/moi/motdepasse', { preHandler: session }, async (req, rep) => {
    const { ancien, nouveau } = req.body || {};
    if (!S.verifierMdp(ancien || '', req.compte.mdp_hash)) return err(rep, 401, 'Mot de passe actuel incorrect.');
    if (String(nouveau || '').length < 10) return err(rep, 400, 'Le nouveau mot de passe doit faire au moins 10 caractères.');
    await pool.query('UPDATE comptes SET mdp_hash = $1 WHERE id = $2', [S.hacherMdp(nouveau), req.compte.id]);
    return { ok: true };
  });

  app.get('/api/moi', { preHandler: poste }, async req => ({
    poste: { id: req.poste.id, num: req.poste.num, code: req.poste.code, nom: req.poste.nom, magasin: req.poste.magasin },
    org: { id: req.poste.org_id, nom: req.poste.org_nom },
  }));

  // ---------- Synchronisation ----------
  // Le poste envoie ses modifications (avec la version de départ) et reçoit tout ce qui a changé depuis « since ».
  app.post('/api/sync', { preHandler: poste }, async (req, rep) => {
    const org = req.poste.org_id;
    const { since = 0, changes = [] } = req.body || {};
    if (!Array.isArray(changes)) return err(rep, 400, 'Format invalide.');
    for (const ch of changes) {
      if (!ch || !M.COLLS[ch.coll] || typeof ch.id !== 'string' || ch.id.length > 300) return err(rep, 400, `Enregistrement invalide (${ch && ch.coll}).`);
    }
    let ecrits = 0;
    const nouvellesZ = [];   // clôtures Z reçues pour la première fois → e-mail de clôture
    if (changes.length) {
      await tx(async c => {
        for (const ch of changes) {
          const { rows } = await c.query('SELECT data, supprime FROM donnees WHERE org_id = $1 AND coll = $2 AND id = $3 FOR UPDATE', [org, ch.coll, ch.id]);
          const cur = rows[0];
          let data, supprime = false;
          if (ch.deleted) {
            // suppression acceptée seulement si personne d'autre n'a modifié l'enregistrement entre-temps
            if (!cur || cur.supprime) continue;
            if (ch.base !== undefined && !M.eq(cur.data, ch.base)) continue;
            data = cur.data; supprime = true;
          } else {
            data = cur && !cur.supprime ? M.merge(ch.coll, ch.base, ch.data, cur.data) : ch.data;
            if (ch.coll === 'clotures' && (!cur || cur.supprime)) nouvellesZ.push(data);
            if (cur && !cur.supprime && M.eq(data, cur.data)) continue;
          }
          await c.query(
            `INSERT INTO donnees (org_id, coll, id, data, rev, maj_le, poste_id, supprime) VALUES ($1,$2,$3,$4,nextval('rev_seq'),now(),$5,$6)
             ON CONFLICT (org_id, coll, id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, maj_le = now(), poste_id = EXCLUDED.poste_id, supprime = EXCLUDED.supprime`,
            [org, ch.coll, ch.id, JSON.stringify(data), req.poste.id, supprime]);
          ecrits++;
        }
      });
    }
    if (nouvellesZ.length) {
      const T = require('./taches');
      setImmediate(async () => { for (const z of nouvellesZ) await T.surCloture({ id: org, nom: req.poste.org_nom }, z, app.log).catch(e => app.log.error({ err: e.message }, 'e-mail de clôture en échec')); });
    }
    const { rows } = await pool.query(
      `SELECT coll, id, data, rev, supprime FROM donnees WHERE org_id = $1 AND rev > $2 ORDER BY rev LIMIT ${LIMITE_PULL}`, [org, Number(since) || 0]);
    // Version serveur de chaque enregistrement envoyé (même s'il n'a pas changé), pour que le poste se recale
    const vus = new Set(rows.map(r => r.coll + '\u0000' + r.id));
    let echos = [];
    const manquants = changes.filter(ch => !vus.has(ch.coll + '\u0000' + ch.id));
    if (manquants.length) {
      ({ rows: echos } = await pool.query(
        `SELECT d.coll, d.id, d.data, d.rev, d.supprime FROM donnees d JOIN unnest($2::text[], $3::text[]) AS k(coll, id) ON d.coll = k.coll AND d.id = k.id WHERE d.org_id = $1`,
        [org, manquants.map(c => c.coll), manquants.map(c => c.id)]));
      const trouves = new Set(echos.map(r => r.coll + '\u0000' + r.id));
      // envoyé comme supprimé mais jamais connu du serveur : on confirme la suppression
      manquants.filter(ch => !trouves.has(ch.coll + '\u0000' + ch.id)).forEach(ch => echos.push({ coll: ch.coll, id: ch.id, data: null, rev: 0, supprime: true }));
    }
    const fmt = r => ({ coll: r.coll, id: r.id, data: r.supprime ? undefined : r.data, deleted: r.supprime || undefined, rev: Number(r.rev) });
    return {
      ecrits,
      rev: rows.length ? Number(rows[rows.length - 1].rev) : Number(since) || 0,
      plus: rows.length === LIMITE_PULL,
      changes: [...rows.map(fmt), ...echos.map(fmt)],
      heure: new Date().toISOString(),
    };
  });

  // ---------- E-mail et lecture automatique ----------
  const SV = require('./services');
  // Numéros de dossier : compteur propre à chaque magasin, demande rejouable (même vente → même numéro)
  app.post('/api/dossiers', { preHandler: poste }, async (req, rep) => {
    const L = (req.body || {}).demandes;
    if (!Array.isArray(L) || L.length > 200 || L.some(d => !d || typeof d.vente !== 'string' || !d.vente || d.vente.length > 100 || typeof d.magasin !== 'string' || !d.magasin || d.magasin.length > 200))
      return err(rep, 400, 'Demande de numéros invalide.');
    const org = req.poste.org_id, numeros = {}, cx = await pool.connect();
    try {
      for (const d of L) {
        await cx.query('BEGIN');
        await cx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [org + '|' + d.magasin]);
        let { rows } = await cx.query('SELECT num FROM dossiers WHERE org_id = $1 AND vente = $2', [org, d.vente]);
        if (!rows.length) ({ rows } = await cx.query(
          `INSERT INTO dossiers (org_id, magasin, vente, num)
           SELECT $1, $2, $3, COALESCE(MAX(num), 0) + 1 FROM dossiers WHERE org_id = $1 AND magasin = $2 RETURNING num`, [org, d.magasin, d.vente]));
        await cx.query('COMMIT');
        numeros[d.vente] = rows[0].num;
      }
    } catch (e) { await cx.query('ROLLBACK').catch(() => {}); throw e; }
    finally { cx.release(); }
    return { numeros };
  });
  // ---------- Intégration : bons de livraison envoyés par un autre logiciel (Prismea) ----------
  app.get('/api/cles', { preHandler: sessionAdmin }, async req => {
    const { rows } = await pool.query('SELECT id, nom, debut, cree_le, vu_le, actif FROM cles_api WHERE org_id = $1 ORDER BY cree_le', [req.compte.org_id]);
    return { cles: rows };
  });
  app.post('/api/cles', { preHandler: sessionAdmin }, async (req, rep) => {
    const nom = String((req.body || {}).nom || '').trim().slice(0, 80);
    if (!nom) return err(rep, 400, 'Donnez un nom à la clé (ex. Prismea).');
    const cle = 'dpt_' + S.nouveauJeton(), id = S.nouvelId('k');
    await pool.query('INSERT INTO cles_api (id, org_id, nom, cle_hash, debut) VALUES ($1,$2,$3,$4,$5)', [id, req.compte.org_id, nom, S.hacherJeton(cle), cle.slice(0, 10)]);
    return { id, nom, cle };   // la clé complète n'est montrée qu'une fois
  });
  app.post('/api/cles/:id/actif', { preHandler: sessionAdmin }, async (req, rep) => {
    const r = await pool.query('UPDATE cles_api SET actif = $1 WHERE id = $2 AND org_id = $3', [!!(req.body || {}).actif, req.params.id, req.compte.org_id]);
    return r.rowCount ? { ok: true } : err(rep, 404, 'Clé introuvable.');
  });
  async function cleApi(req, rep) {
    const j = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
    const { rows } = await pool.query(`SELECT k.*, o.nom AS org_nom FROM cles_api k JOIN organisations o ON o.id = k.org_id WHERE k.cle_hash = $1 AND k.actif AND o.actif`, [S.hacherJeton(j || '-')]);
    if (!rows[0]) return err(rep, 401, 'Clé d\'intégration invalide ou désactivée.');
    req.cle = rows[0];
    pool.query('UPDATE cles_api SET vu_le = now() WHERE id = $1', [rows[0].id]).catch(() => {});
  }
  const txt = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
  const nb = v => { const n = Number(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
  // Un bon de livraison / une facture Prismea → « livraison à réceptionner » dans DIOPTRA (même numéro renvoyé = mise à jour)
  app.post('/api/livraisons', { preHandler: cleApi }, async (req, rep) => {
    const b = req.body || {}, L = Array.isArray(b.lignes) ? b.lignes : null;
    const numero = txt(b.numero || b.facture || b.bl, 60);
    if (!numero) return err(rep, 400, 'Numéro du bon de livraison ou de la facture manquant.');
    if (!L || !L.length || L.length > 2000) return err(rep, 400, 'Lignes manquantes (1 à 2000).');
    const lignes = L.map((l, i) => ({ n: i + 1, ean: txt(l.ean, 20).replace(/\s/g, ''), ref: txt(l.etiquette || l.ref || l.reference, 40), marque: txt(l.marque, 60),
      modele: txt(l.modele, 80), coloris: txt(l.coloris || l.couleur, 60), taille: txt(l.taille, 30), qte: Math.max(0, Math.round(nb(l.qte ?? l.quantite ?? 1))), pu: Math.max(0, nb(l.pu ?? l.prix ?? l.prixHT)) }));
    if (lignes.some(l => !l.qte || !(l.ean || l.ref || l.modele))) return err(rep, 400, 'Chaque ligne doit avoir une quantité et un code EAN, une référence ou un modèle.');
    const source = txt(b.source || req.cle.nom, 60), id = 'liv-' + source.toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + numero.replace(/[^\w.-]+/g, '_');
    const devise = txt(b.devise || 'EUR', 3).toUpperCase();
    const data = { id, source, numero, bl: txt(b.bl, 60), date: txt(b.date, 30) || new Date().toISOString().slice(0, 10), echeance: txt(b.echeance, 30), devise,
      fournisseur: txt(b.fournisseur || source, 120), magasin: txt(b.magasin, 120), commentaire: txt(b.commentaire, 500), lignes,
      total: b.total != null ? nb(b.total) : Math.round(lignes.reduce((a, l) => a + l.qte * l.pu, 0) * 100) / 100,
      statut: 'À réceptionner', recuLe: new Date().toISOString() };
    let etat = 'creee';
    await tx(async c => {
      const { rows } = await c.query(`SELECT data, supprime FROM donnees WHERE org_id = $1 AND coll = 'livraisons' AND id = $2 FOR UPDATE`, [req.cle.org_id, 'i:' + id]);
      const cur = rows[0];
      if (cur && !cur.supprime && cur.data.statut !== 'À réceptionner') { etat = 'deja'; return; }
      if (cur && !cur.supprime) etat = 'maj';
      await c.query(`INSERT INTO donnees (org_id, coll, id, data, rev, maj_le, poste_id, supprime) VALUES ($1,'livraisons',$2,$3,nextval('rev_seq'),now(),NULL,false)
        ON CONFLICT (org_id, coll, id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, maj_le = now(), poste_id = NULL, supprime = false`, [req.cle.org_id, 'i:' + id, JSON.stringify(data)]);
    });
    if (etat === 'deja') return rep.code(409).send({ erreur: 'Cette livraison a déjà été réceptionnée dans DIOPTRA.', id });
    return { ok: true, id, etat, articles: lignes.reduce((a, l) => a + l.qte, 0) };
  });

  // ---------- Centrale d'achat Prismea : catalogue et commandes (la clé psm_ reste sur le serveur) ----------
  const centraleDe = async org => (await pool.query('SELECT url, cle FROM centrale WHERE org_id = $1', [org])).rows[0] || null;
  const baseUrl = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/api(\/(commandes|catalogue))?$/, '');
  const urlOk = u => { try { const x = new URL(u); return x.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1)$/.test(x.hostname)); } catch (_) { return false; } };
  async function versCentrale(org, chemin, opts = {}) {
    const c = await centraleDe(org);
    if (!c || !c.cle) { const e = new Error('La centrale n\'est pas configurée. Un administrateur doit renseigner l\'adresse et la clé Prismea (Paramètres › Postes et accès).'); e.status = 400; throw e; }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), opts.delai || 20000);
    let r;
    try {
      r = await fetch(c.url + chemin, { method: opts.corps ? 'POST' : 'GET', signal: ctl.signal,
        headers: { authorization: 'Bearer ' + c.cle, accept: 'application/json', ...(opts.corps ? { 'content-type': 'application/json' } : {}) }, body: opts.corps ? JSON.stringify(opts.corps) : undefined });
    } catch (e) { const x = new Error(e.name === 'AbortError' ? 'La centrale ne répond pas, réessayez dans un instant.' : 'Centrale injoignable.'); x.status = 502; throw x; }
    finally { clearTimeout(t); }
    if (opts.brut) return r;
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const x = new Error(r.status === 401 ? 'Clé de la centrale refusée : vérifiez-la dans Paramètres › Postes et accès.' : (j.erreur || j.error || `Erreur de la centrale (${r.status})`)); x.status = r.status === 401 ? 400 : r.status; x.corps = j; throw x; }
    return j;
  }
  app.get('/api/centrale', { preHandler: sessionAdmin }, async req => {
    const c = await centraleDe(req.compte.org_id);
    return { url: c ? c.url : '', cle: c && c.cle ? c.cle.slice(0, 8) + '…' + c.cle.slice(-4) : '', configure: !!(c && c.cle) };
  });
  app.post('/api/centrale', { preHandler: sessionAdmin }, async (req, rep) => {
    const b = req.body || {}, cur = await centraleDe(req.compte.org_id);
    const url = baseUrl(b.url || (cur && cur.url));
    if (!urlOk(url)) return err(rep, 400, 'Adresse invalide : elle doit commencer par https:// (ex. https://prismea.onrender.com).');
    let cle = cur ? cur.cle : '';
    if (b.retirer) cle = '';
    else if (b.cle != null && String(b.cle).trim()) { cle = String(b.cle).trim(); if (!/^psm_[A-Za-z0-9_\-]{16,}$/.test(cle)) return err(rep, 400, 'La clé doit commencer par psm_ (créée dans Prismea › Paramètres › Commandes des opticiens).'); }
    await pool.query(`INSERT INTO centrale (org_id, url, cle, maj_le, maj_par) VALUES ($1,$2,$3,now(),$4)
      ON CONFLICT (org_id) DO UPDATE SET url = EXCLUDED.url, cle = EXCLUDED.cle, maj_le = now(), maj_par = EXCLUDED.maj_par`, [req.compte.org_id, url, cle, req.compte.email]);
    if (cle && b.tester !== false) { try { const j = await versCentrale(req.compte.org_id, '/api/catalogue'); return { ok: true, test: `Connexion réussie : ${j.montures.length} montures disponibles à la centrale.` }; } catch (e) { return { ok: true, test: 'Enregistré, mais le test a échoué : ' + e.message }; } }
    return { ok: true };
  });
  app.get('/api/centrale/etat', { preHandler: poste }, async req => { const c = await centraleDe(req.poste.org_id); return { configure: !!(c && c.cle) }; });
  app.get('/api/centrale/catalogue', { preHandler: poste }, async (req, rep) => {
    try { return await versCentrale(req.poste.org_id, '/api/catalogue'); } catch (e) { return err(rep, e.status || 502, e.message); }
  });
  app.get('/api/centrale/photo/:id', { preHandler: poste }, async (req, rep) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return err(rep, 404, 'Photo introuvable.');
    try {
      const r = await versCentrale(req.poste.org_id, '/api/catalogue/photo/' + req.params.id, { brut: true });
      if (!r.ok) return err(rep, r.status === 401 ? 400 : 404, 'Photo indisponible.');
      rep.header('content-type', r.headers.get('content-type') || 'image/jpeg').header('cache-control', 'private, max-age=31536000, immutable');
      return rep.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { return err(rep, e.status || 502, e.message); }
  });
  app.post('/api/centrale/commandes', { preHandler: poste }, async (req, rep) => {
    const b = req.body || {}, L = Array.isArray(b.lignes) ? b.lignes : [];
    const numero = txt(b.numero, 60);
    if (!/^[A-Z0-9][A-Z0-9-]{3,59}$/.test(numero)) return err(rep, 400, 'Numéro de commande invalide.');
    if (!L.length || L.length > 1000) return err(rep, 400, 'La commande est vide.');
    const mags = await magasinsDe(req.poste.org_id), magasin = txt(b.magasin, 120) || req.poste.magasin;
    if (mags.length && !mags.some(m => m.nom === magasin)) return err(rep, 400, 'Magasin inconnu.');
    const corps = { source: 'DIOPTRA', numero, magasin, date: new Date().toISOString().slice(0, 10), commentaire: txt(b.commentaire, 500),
      lignes: L.map(l => ({ ean: txt(l.ean, 20), etiquette: txt(l.etiquette, 40), marque: txt(l.marque, 60), modele: txt(l.modele, 80), coloris: txt(l.coloris, 60), taille: txt(l.taille, 30), qte: Math.max(0, Math.round(nb(l.qte))) })).filter(l => l.qte) };
    if (!corps.lignes.length) return err(rep, 400, 'La commande est vide.');
    try { return await versCentrale(req.poste.org_id, '/api/commandes', { corps }); } catch (e) { return err(rep, e.status || 502, e.message); }
  });
  app.post('/api/centrale/statuts', { preHandler: poste }, async (req, rep) => {
    const n = Array.isArray((req.body || {}).numeros) ? req.body.numeros.slice(0, 200).map(x => txt(x, 60)) : [];
    if (!n.length) return { commandes: [] };
    try { return await versCentrale(req.poste.org_id, '/api/commandes/statuts', { corps: { source: 'DIOPTRA', numeros: n } }); } catch (e) { return err(rep, e.status || 502, e.message); }
  });

  app.get('/api/sante', async () => ({ ok: true, version: 1, mail: SV.mailConfigure(), ia: SV.iaConfiguree() }));
  app.post('/api/mail', { preHandler: poste }, async (req, rep) => {
    const { to, subject, body, replyTo, attachments = [] } = req.body || {};
    const dest = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!dest.length || dest.some(x => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x).trim()))) return err(rep, 400, 'Adresse e-mail invalide.');
    if (!subject) return err(rep, 400, 'Objet manquant.');
    if (!Array.isArray(attachments) || attachments.length > 5) return err(rep, 400, 'Pièces jointes invalides.');
    try {
      await SV.envoyerMail({ orgId: req.poste.org_id, orgNom: req.poste.org_nom, to: dest, subject: String(subject).slice(0, 300), text: String(body || ''),
        replyTo: replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo) ? replyTo : undefined, attachments });
      return { ok: true };
    } catch (e) { return err(rep, e.status || 500, e.message); }
  });
  app.post('/api/ia/json', { preHandler: poste }, async (req, rep) => {
    const { prompt, images = [] } = req.body || {};
    if (!prompt || String(prompt).length > 200000) return err(rep, 400, 'Demande invalide.');
    try { return { resultat: await SV.iaJson(String(prompt), Array.isArray(images) ? images : []) }; }
    catch (e) { return err(rep, e.status || 500, e.message); }
  });

  // Essai immédiat de l'e-mail de caisse (bouton dans Paramètres)
  app.post('/api/rapports/essai', { preHandler: poste }, async (req, rep) => {
    const T = require('./taches');
    try {
      const r = await T.rapportsOrg({ id: req.poste.org_id, nom: req.poste.org_nom }, T.jourDe(), true);
      return { ok: true, envoyes: r.envoyes };
    } catch (e) { return err(rep, e.status || 500, e.message); }
  });

  // ---------- Création d'un opticien (réservé au propriétaire de DIOPTRA) ----------
  app.post('/api/admin/organisations', async (req, rep) => {
    const cle = process.env.ADMIN_KEY;
    if (!cle || req.headers['x-admin-key'] !== cle) return err(rep, 403, 'Accès refusé.');
    const { nom, email, motdepasse, nomAdmin } = req.body || {};
    if (!nom || !email || !motdepasse || String(motdepasse).length < 10) return err(rep, 400, 'Nom, e-mail et mot de passe (10 caractères minimum) obligatoires.');
    return creerOrganisation({ nom, email, motdepasse, nomAdmin });
  });

  // ---------- Application (fichiers statiques) ----------
  app.register(require('@fastify/static'), {
    root: PUBLIC, index: ['index.html'],
    setHeaders(res, p) {
      const h = (k, v) => (typeof res.setHeader === 'function' ? res.setHeader(k, v) : res.header(k, v));
      if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(p)) h('Cache-Control', 'no-cache');
      h('X-Content-Type-Options', 'nosniff');
    },
  });
  app.setNotFoundHandler((req, rep) => {
    if (req.url.startsWith('/api/')) return err(rep, 404, 'Introuvable.');
    return rep.sendFile('index.html');
  });

  return app;
}

async function creerOrganisation({ nom, email, motdepasse, nomAdmin }) {
  const orgId = S.nouvelId('org_'), compteId = S.nouvelId('cpt_');
  await tx(async c => {
    await c.query('INSERT INTO organisations (id, nom) VALUES ($1, $2)', [orgId, nom]);
    await c.query('INSERT INTO comptes (id, org_id, email, nom, mdp_hash) VALUES ($1,$2,$3,$4,$5)',
      [compteId, orgId, String(email).trim().toLowerCase(), nomAdmin || nom, S.hacherMdp(motdepasse)]);
  });
  return { org: { id: orgId, nom }, compte: { id: compteId, email } };
}

module.exports = { construire, creerOrganisation };
