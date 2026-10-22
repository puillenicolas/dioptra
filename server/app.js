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
