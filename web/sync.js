/*
 * DIOPTRA — synchronisation et fonctionnement hors ligne
 *
 * - Toutes les données restent sur le poste (IndexedDB) : l'application fonctionne sans internet.
 * - Chaque modification est mise en file et envoyée au serveur dès que la connexion revient.
 * - Les modifications des autres postes sont récupérées et fusionnées (voir shared/merge.js).
 */
(function () {
  'use strict';
  const M = window.DMERGE;
  const COLLS = M.COLLS;
  const VERSION = '__VERSION__';

  // ------------------------------------------------------------------ IndexedDB (clé → valeur)
  const IDB = {
    db: null, file: new Map(), minuteur: null,
    ouvrir() {
      return new Promise((ok, ko) => {
        const r = indexedDB.open('dioptra', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; ok(); };
        r.onerror = () => ko(r.error);
      });
    },
    toutLire() {
      return new Promise((ok, ko) => {
        const out = new Map(), tx = this.db.transaction('kv', 'readonly'), st = tx.objectStore('kv');
        const req = st.openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else ok(out); };
        req.onerror = () => ko(req.error);
      });
    },
    ecrire(k, v) { this.file.set(k, v); clearTimeout(this.minuteur); this.minuteur = setTimeout(() => this.vider(), 250); },
    vider() {
      clearTimeout(this.minuteur);
      if (!this.file.size || !this.db) return Promise.resolve();
      const lot = this.file; this.file = new Map();
      return new Promise(ok => {
        const tx = this.db.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
        lot.forEach((v, k) => v === undefined ? st.delete(k) : st.put(v, k));
        tx.oncomplete = () => ok(); tx.onerror = () => { console.error('IndexedDB', tx.error); ok(); };
      });
    },
    effacerTout() {
      return new Promise(ok => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').clear(); tx.oncomplete = () => ok(); });
    },
  };

  // ------------------------------------------------------------------ État
  const S = {
    mem: new Map(),          // valeurs vues par l'application (équivalent localStorage)
    snaps: {},               // dernière version serveur connue de chaque enregistrement
    meta: {},                // jeton du poste, poste, opticien, curseur de synchronisation
    dirty: new Set(),        // collections modifiées localement depuis la dernière synchro
    enCours: false, encore: false, minuteur: null,
    etat: 'init', attente: 0, derniere: null, erreur: '', majDispo: false, appLancee: false,
  };
  const sauverMeta = () => IDB.ecrire('meta', S.meta);
  const sauverSnap = coll => IDB.ecrire('snap:' + coll, S.snaps[coll] || {});

  // ------------------------------------------------------------------ Stockage vu par l'application
  window.DSTORE = {
    getItem(k) { const v = S.mem.get(String(k)); return v === undefined ? null : v; },
    setItem(k, v) {
      k = String(k); v = String(v);
      if (S.mem.get(k) === v) return;
      S.mem.set(k, v); IDB.ecrire('ls:' + k, v);
      if (COLLS[k]) { S.dirty.add(k); aEnvoyer(); }
    },
    removeItem(k) { k = String(k); S.mem.delete(k); IDB.ecrire('ls:' + k, undefined); if (COLLS[k]) { S.dirty.add(k); aEnvoyer(); } },
    get length() { return S.mem.size; },
    key(i) { return [...S.mem.keys()][i] ?? null; },
    clear() { [...S.mem.keys()].forEach(k => this.removeItem(k)); },
  };

  // ------------------------------------------------------------------ Réseau
  async function api(url, corps, jeton) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
    let r;
    try {
      r = await fetch(url, {
        method: corps === undefined ? 'GET' : 'POST', signal: ctl.signal, cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(jeton ? { authorization: 'Bearer ' + jeton } : {}) },
        body: corps === undefined ? undefined : JSON.stringify(corps),
      });
    } catch (e) { const x = new Error('Pas de connexion internet.'); x.reseau = true; throw x; }
    finally { clearTimeout(t); }
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const x = new Error(j.erreur || `Erreur serveur (${r.status})`); x.status = r.status; throw x; }
    return j;
  }

  // ------------------------------------------------------------------ Différences locales
  function calculer(colls) {
    const out = [];
    for (const coll of colls) {
      const raw = S.mem.get(coll); if (raw == null) continue;
      const cur = M.split(coll, raw), snap = S.snaps[coll] || {};
      for (const id in cur) if (!(id in snap) || !M.eq(cur[id], snap[id])) out.push({ coll, id, data: cur[id], base: snap[id] });
      for (const id in snap) if (!(id in cur)) out.push({ coll, id, deleted: true, base: snap[id] });
    }
    return out;
  }

  // ------------------------------------------------------------------ Mise à jour sur place des objets de l'application
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const cleItem = it => isObj(it) ? (it.id != null ? 'i:' + it.id : it.numero != null ? 'n:' + it.numero : null) : null;
  function patchObj(t, s) {
    Object.keys(t).forEach(k => { if (!(k in s)) delete t[k]; });
    Object.keys(s).forEach(k => { t[k] = patchVal(t[k], s[k]); });
    return t;
  }
  function patchVal(t, s) {
    if (isObj(t) && isObj(s)) return patchObj(t, s);
    if (Array.isArray(t) && Array.isArray(s) && s.every(x => cleItem(x) !== null)) {
      const m = new Map(t.map(x => [cleItem(x), x]));
      const n = s.map(x => { const o = m.get(cleItem(x)); return isObj(o) ? patchObj(o, x) : M.clone(x); });
      t.splice(0, t.length, ...n);
      return t;
    }
    return M.clone(s);
  }
  function patchLive(coll, cur, ids) {
    const app = window.DIOPTRA_APP; const get = app && app.live && app.live[coll]; if (!get) return;
    const A = get(); if (!A) return;
    const type = COLLS[coll];
    if (type === 'list' && Array.isArray(A)) {
      const idx = new Map(); A.forEach((x, i) => idx.set(M.recId(x), i));
      const retirer = [];
      ids.forEach(id => {
        const n = cur[id], i = idx.get(id);
        if (n === undefined) { if (i !== undefined) retirer.push(i); }
        else if (i !== undefined && isObj(A[i])) patchObj(A[i], n);
        else A.push(M.clone(n));
      });
      retirer.sort((a, b) => b - a).forEach(i => A.splice(i, 1));
    } else if (type === 'map' && isObj(A)) {
      ids.forEach(id => { const n = cur[id]; if (n === undefined) delete A[id]; else A[id] = patchVal(A[id], n.v); });
    } else if (type === 'doc' && isObj(A) && cur._ && isObj(cur._.v)) patchObj(A, cur._.v);
  }

  // ------------------------------------------------------------------ Application des données du serveur
  function appliquer(changes, envoyes) {
    const env = new Map((envoyes || []).map(c => [c.coll + '\u0000' + c.id, c]));
    const parColl = new Map();
    changes.forEach(c => { if (COLLS[c.coll]) { if (!parColl.has(c.coll)) parColl.set(c.coll, []); parColl.get(c.coll).push(c); } });
    const touchees = new Set();
    parColl.forEach((liste, coll) => {
      const raw = S.mem.get(coll), cur = M.split(coll, raw), ordre = Object.keys(cur);
      const snap = S.snaps[coll] || (S.snaps[coll] = {});
      const modifies = new Set();
      liste.forEach(sc => {
        const sent = env.get(coll + '\u0000' + sc.id), local = cur[sc.id];
        const base = sent ? (sent.deleted ? undefined : sent.data) : snap[sc.id];
        const localChange = sent
          ? (sent.deleted ? local !== undefined : (local === undefined || !M.eq(local, sent.data)))
          : (local === undefined ? false : !M.eq(local, snap[sc.id]));
        let nouveau;
        if (sc.deleted) {
          delete snap[sc.id];
          nouveau = localChange && local !== undefined ? local : undefined;
        } else {
          snap[sc.id] = sc.data;
          if (!localChange) nouveau = sc.data;
          else if (local === undefined) nouveau = undefined;           // supprimé ici pendant l'envoi : la suppression repartira
          else nouveau = M.merge(coll, base, local, sc.data);
        }
        if (localChange) S.dirty.add(coll);
        if (nouveau === undefined) { if (sc.id in cur) { delete cur[sc.id]; modifies.add(sc.id); } }
        else if (!M.eq(cur[sc.id], nouveau)) { cur[sc.id] = nouveau; modifies.add(sc.id); }
      });
      sauverSnap(coll);
      if (modifies.size) {
        const v = M.join(coll, cur, ordre);
        if (v == null) { S.mem.delete(coll); IDB.ecrire('ls:' + coll, undefined); } else { S.mem.set(coll, v); IDB.ecrire('ls:' + coll, v); }
        if (S.appLancee) { try { patchLive(coll, cur, modifies); } catch (e) { console.error('patch', coll, e); } }
        touchees.add(coll);
      }
    });
    if (S.appLancee && touchees.size && window.DIOPTRA_APP) {
      try { if (window.DIOPTRA_APP.apres(touchees)) S.majDispo = true; } catch (e) { console.error('apres', e); }
    }
    return touchees;
  }

  // ------------------------------------------------------------------ Cycle de synchronisation
  function planifier(ms) { clearTimeout(S.minuteur); S.minuteur = setTimeout(cycle, ms); }
  // une modification locale vient d'être enregistrée : envoi groupé dans moins d'une seconde
  function aEnvoyer() {
    if (S.etat === 'ok') etat('attente');
    if (S.etat === 'horsligne' || S.etat === 'erreur') {
      // pas de connexion : on met seulement à jour le nombre de modifications en attente (nouvel essai déjà prévu)
      clearTimeout(S.cpt); S.cpt = setTimeout(() => { try { S.attente = calculer([...S.dirty]).length; dessinerPill(); } catch (_) {} }, 600);
      return;
    }
    planifier(800);
  }

  async function cycle() {
    if (!S.meta.jeton) return;
    if (S.enCours) { S.encore = true; return; }
    S.enCours = true; clearTimeout(S.minuteur);
    let colls = [];
    try {
      let tours = 0;
      do {
        S.encore = false;
        colls = [...S.dirty]; S.dirty.clear();
        const changes = calculer(colls);
        S.attente = changes.length;
        if (changes.length) etat('sync');
        let i = 0, plus = true;
        while (i < changes.length || plus) {
          const lot = []; let taille = 0;
          while (i < changes.length && lot.length < 300 && taille < 3e6) {
            const c = changes[i++]; lot.push(c);
            taille += JSON.stringify(c.data ?? null).length + JSON.stringify(c.base ?? null).length;
          }
          const rep = await api('/api/sync', { since: S.meta.since || 0, changes: lot }, S.meta.jeton);
          appliquer(rep.changes || [], lot);
          S.meta.since = rep.rev; sauverMeta();
          S.attente = Math.max(0, changes.length - i);
          plus = !!rep.plus;
          if (rep.heure) S.decalage = Date.parse(rep.heure) - Date.now();
        }
        colls = [];
      } while ((S.encore || S.dirty.size) && ++tours < 4);
      S.derniere = Date.now(); S.erreur = '';
      if (S.dirty.size) { etat('attente'); planifier(800); }
      else { etat('ok'); planifier(document.hidden ? 120000 : 30000); }
    } catch (e) {
      colls.forEach(c => S.dirty.add(c));
      try { S.attente = calculer([...S.dirty]).length; } catch (_) {}
      if (e.status === 401) { S.erreur = e.message; etat('revoque'); }
      else { S.erreur = e.message; etat(e.reseau ? 'horsligne' : 'erreur'); planifier(e.reseau ? 15000 : 60000); }
    } finally {
      S.enCours = false;
      IDB.vider();
    }
  }

  // ------------------------------------------------------------------ Indicateur de synchronisation
  let pill;
  function etat(e) { S.etat = e; dessinerPill(); }
  const hh = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  function dessinerPill() {
    if (!pill) return;
    const L = {
      init: ['', 'Démarrage…'],
      sync: ['sync', 'Synchronisation…'],
      attente: ['sync', 'Enregistrement…'],
      ok: ['ok', S.derniere ? `Synchronisé · ${hh(S.derniere)}` : 'Synchronisé'],
      horsligne: ['off', `Hors ligne${S.attente ? ` · ${S.attente} modification${S.attente > 1 ? 's' : ''} en attente` : ' · tout est enregistré sur ce poste'}`],
      erreur: ['off', `Synchronisation en échec · nouvel essai bientôt`],
      revoque: ['ko', 'Poste désactivé · cliquer pour réactiver'],
    }[S.etat] || ['', ''];
    pill.className = 'dsync ' + L[0];
    pill.querySelector('.t').textContent = L[1];
    pill.title = [S.meta.org && `Opticien : ${S.meta.org.nom}`, S.meta.poste && `Poste : ${S.meta.poste.nom} (${S.meta.poste.code})`, S.erreur].filter(Boolean).join('\n');
    pill.querySelector('.maj').hidden = !S.majDispo;
  }
  function creerPill() {
    pill = document.createElement('div');
    pill.className = 'dsync'; pill.setAttribute('role', 'status');
    pill.innerHTML = '<button type="button" class="b"><i></i><span class="t"></span></button><button type="button" class="maj" hidden>Actualiser</button>';
    pill.querySelector('.b').addEventListener('click', () => { if (S.etat === 'revoque') { reactiver(); return; } cycle(); });
    pill.querySelector('.maj').addEventListener('click', () => { S.majDispo = false; dessinerPill(); try { window.DIOPTRA_APP.actualiser(); } catch (_) {} });
    document.body.appendChild(pill);
    dessinerPill();
  }

  // ------------------------------------------------------------------ Styles (écran d'activation + indicateur)
  const css = `
  .dsync{position:fixed;left:12px;bottom:12px;z-index:60;display:flex;gap:6px;align-items:center;font:500 12px/1.2 Geist,system-ui,sans-serif}
  .dsync button{font:inherit;border:1px solid var(--line,#e6e6e6);background:var(--card,#fff);color:var(--muted,#6b6b6b);border-radius:99px;padding:6px 11px;cursor:pointer;display:flex;gap:7px;align-items:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .dsync i{width:8px;height:8px;border-radius:50%;background:#bbb;display:inline-block}
  .dsync.ok i{background:#1f9d55}.dsync.sync i{background:#2f5bea;animation:dsp 1s infinite}.dsync.off i{background:#d97706}.dsync.ko i{background:#dc2626}
  .dsync.off .b,.dsync.ko .b{color:var(--ink,#111)}
  .dsync .maj{background:#2f5bea;border-color:#2f5bea;color:#fff}
  @keyframes dsp{50%{opacity:.3}}
  @media print{.dsync{display:none}}
  .dact{position:fixed;inset:0;z-index:100;background:#fff;color:#111;font:15px/1.5 Geist,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
  .dact .box{width:min(440px,100%);display:grid;gap:16px}
  .dact .logo{display:flex;align-items:center;gap:12px;font-size:28px;font-weight:600;letter-spacing:-.04em}
  .dact h1{font-size:20px;margin:0;font-weight:600;letter-spacing:-.02em}
  .dact p{margin:0;color:#6b6b6b;font-size:14px}
  .dact label{display:grid;gap:6px;font-size:13px;font-weight:500}
  .dact input,.dact select{font:inherit;padding:11px 12px;border:1px solid #d9d9d9;border-radius:8px;background:#fff;color:#111;width:100%;box-sizing:border-box}
  .dact input:focus,.dact select:focus{outline:2px solid #2f5bea;outline-offset:-1px}
  .dact .row{display:grid;grid-template-columns:1fr 130px;gap:10px}
  .dact button.go{font:inherit;font-weight:600;background:#2f5bea;color:#fff;border:0;border-radius:8px;padding:12px;cursor:pointer}
  .dact button.go:disabled{opacity:.6;cursor:wait}
  .dact button.lien{font:inherit;background:none;border:0;color:#6b6b6b;cursor:pointer;padding:0;text-align:left;text-decoration:underline}
  .dact .err{color:#dc2626;font-size:13px;min-height:1em}
  .dact .note{font-size:12px;color:#6b6b6b;border-top:1px solid #eee;padding-top:12px}
  @media (prefers-color-scheme:dark){.dact{background:#0d0d0d;color:#f2f2f2}.dact input,.dact select{background:#161616;color:#f2f2f2;border-color:#333}.dact p,.dact .note{color:#9a9a9a}.dact .note{border-color:#222}}
  `;
  const LOGO = '<svg width="44" height="26" viewBox="0 0 64 36" aria-hidden="true"><circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="46" cy="18" r="14" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="46" cy="18" r="4" fill="#2f5bea"/></svg>';
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sansAccents = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  function suggestionCode(mag, postes) {
    const mots = sansAccents(mag).toUpperCase().replace(/^MAGASIN\s+/, '').replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    // dernier mot du nom (souvent la ville) : « FV Lomé » → LOM, « Fashion Vision Libreville » → LIB
    const base = (mots.length ? mots[mots.length - 1] : 'POS').slice(0, 3).padEnd(3, 'X');
    const pris = new Set((postes || []).map(p => p.code));
    for (let n = 1; n < 100; n++) if (!pris.has(base + n)) return base + n;
    return base + Date.now() % 100;
  }

  // ------------------------------------------------------------------ Écran d'activation d'un poste
  function activer(message) {
    return new Promise(fini => {
      const el = document.createElement('div');
      el.className = 'dact';
      document.body.appendChild(el);
      let cx = null;
      const etape1 = () => {
        el.innerHTML = `<form class="box" autocomplete="on">
          <div class="logo">${LOGO}<span>dioptra</span></div>
          <h1>Activer ce poste</h1>
          <p>${message ? esc(message) : 'Connectez-vous avec le compte administrateur de votre magasin. Cette étape n\'est à faire qu\'une fois par appareil.'}</p>
          <label>E-mail<input name="email" type="email" required autocomplete="username"></label>
          <label>Mot de passe<input name="mdp" type="password" required autocomplete="current-password"></label>
          <div class="err" role="alert"></div>
          <button class="go" type="submit">Continuer</button>
          <p class="note">Une connexion internet est nécessaire pour activer le poste. Ensuite, DIOPTRA fonctionne aussi hors ligne.</p></form>`;
        const f = el.querySelector('form'); f.email.focus();
        f.addEventListener('submit', async e => {
          e.preventDefault(); const b = f.querySelector('.go'), er = f.querySelector('.err'); b.disabled = true; er.textContent = '';
          try { cx = await api('/api/connexion', { email: f.email.value.trim(), motdepasse: f.mdp.value }); etape2(); }
          catch (x) { er.textContent = x.message; b.disabled = false; }
        });
      };
      const etape2 = () => {
        const mags = cx.magasins || [];
        el.innerHTML = `<form class="box">
          <div class="logo">${LOGO}<span>dioptra</span></div>
          <h1>${esc(cx.org.nom)}</h1>
          <p>Bonjour ${esc(cx.compte.nom)}. Dans quel magasin se trouve ce poste ?${cx.compte.role === 'activation' ? ' (magasins attribués à votre compte)' : ''}</p>
          ${mags.length ? `<label>Magasin<select name="mag">${mags.map(m => `<option>${esc(m.nom)}</option>`).join('')}</select></label>`
            : `<label>Nom de votre premier magasin<input name="mag" required placeholder="ex. Fashion Vision Libreville"></label>
               <p style="font-size:13px">Vous pourrez ajouter les autres magasins ensuite dans Paramètres.</p>`}
          <div class="row">
            <label>Nom du poste<input name="nom" required placeholder="ex. Caisse"></label>
            <label>Code du poste<input name="code" required maxlength="6" pattern="[A-Za-z0-9]{2,6}" style="text-transform:uppercase"></label>
          </div>
          <p style="font-size:13px">Le code apparaît dans les numéros de facture de ce poste (ex. FA-<b class="ex">LBV1</b>-2026-0001). Il ne pourra plus changer.</p>
          <div class="err" role="alert"></div>
          <button class="go" type="submit">Activer le poste</button>
          <button class="lien" type="button">Changer de compte</button></form>`;
        const f = el.querySelector('form');
        const maj = () => { const c = suggestionCode(f.mag.value, cx.postes); if (!f.code.dataset.touche) f.code.value = c; el.querySelector('.ex').textContent = (f.code.value || c).toUpperCase(); if (!f.nom.dataset.touche) f.nom.value = 'Caisse'; };
        f.mag.addEventListener('input', maj); f.mag.addEventListener('change', maj);
        f.code.addEventListener('input', () => { f.code.dataset.touche = 1; el.querySelector('.ex').textContent = f.code.value.toUpperCase(); });
        f.nom.addEventListener('input', () => { f.nom.dataset.touche = 1; });
        maj();
        f.querySelector('.lien').addEventListener('click', etape1);
        f.addEventListener('submit', async e => {
          e.preventDefault(); const b = f.querySelector('.go'), er = f.querySelector('.err'); b.disabled = true; er.textContent = '';
          try {
            const mag = f.mag.value.trim();
            const r = await api('/api/postes', { nom: f.nom.value.trim(), code: f.code.value.trim(), magasin: mag }, cx.session);
            b.textContent = 'Récupération des données…';
            const ancienOrg = S.meta.org && S.meta.org.id;
            if (ancienOrg && ancienOrg !== r.org.id) { await IDB.effacerTout(); S.mem.clear(); S.snaps = {}; S.meta = {}; }
            S.meta = { ...S.meta, jeton: r.jeton, poste: r.poste, org: r.org, compte: r.compte, since: ancienOrg === r.org.id ? S.meta.since : 0 };
            sauverMeta();
            // première récupération complète
            let plus = true;
            while (plus) {
              const rep = await api('/api/sync', { since: S.meta.since || 0, changes: [] }, S.meta.jeton);
              appliquer(rep.changes || [], []); S.meta.since = rep.rev; plus = !!rep.plus;
            }
            if (!S.mem.get('parametres')) semer(mag, cx.compte);
            DSTORE.setItem('boutique', mag);
            sauverMeta(); await IDB.vider();
            el.remove(); fini();
          } catch (x) { er.textContent = x.message; b.disabled = false; b.textContent = 'Activer le poste'; }
        });
      };
      etape1();
    });
  }

  // Nouvel opticien : premier magasin et administrateur (le code PIN sera demandé au démarrage)
  function semer(mag, compte) {
    const parts = String(compte.nom || 'Administrateur').trim().split(/\s+/);
    const prenom = parts[0], nom = parts.slice(1).join(' ');
    const id = 'u' + Date.now().toString(36);
    const P = {
      app: { nom: 'DIOPTRA', pied: '' },
      magasins: [{ id: 'm' + Date.now().toString(36), nom: mag, raison: '', adresse: '', ville: '', tel: '', email: '', rccm: '', nif: '', logo: '', actif: true }],
      users: [{ id, prenom, nom, ini: ((prenom[0] || 'A') + (nom[0] || '')).toUpperCase(), role: 'admin', magasins: [], pin: '', actif: true }],
    };
    DSTORE.setItem('parametres', JSON.stringify(P));
    DSTORE.setItem('user', id);
  }

  async function reactiver() {
    await activer('Ce poste a été désactivé ou son accès a expiré. Reconnectez-vous avec un compte administrateur pour le réactiver. Les données enregistrées sur ce poste sont conservées.');
    location.reload();
  }

  // ------------------------------------------------------------------ Démarrage
  function lancerApp() {
    const src = document.querySelector('script[type="text/dioptra-app"]');
    const b64 = blob => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = ko; r.readAsDataURL(blob); });
    const enLigneSinon = msg => e => { if (e.reseau) throw new Error(msg); throw e; };
    window.DSYNC = {
      poste: S.meta.poste, org: S.meta.org, version: VERSION,
      synchroniser: () => cycle(),
      etat: () => ({ etat: S.etat, attente: S.attente, derniere: S.derniere, erreur: S.erreur, since: S.meta.since }),
      // e-mail envoyé par le serveur (pièces jointes en base64)
      envoyerMail: corps => api('/api/mail', corps, S.meta.jeton).catch(enLigneSinon('Pas de connexion internet : l\'e-mail n\'a pas pu partir. Réessayez quand la connexion revient.')),
      connexionAdmin: (email, motdepasse) => api('/api/connexion', { email, motdepasse }).catch(enLigneSinon('Pas de connexion internet.')),
      listePostes: session => api('/api/postes', undefined, session).catch(enLigneSinon('Pas de connexion internet.')),
      posteActif: (session, id, actif) => api('/api/postes/' + encodeURIComponent(id) + '/actif', { actif }, session).catch(enLigneSinon('Pas de connexion internet.')),
      listeComptes: session => api('/api/comptes', undefined, session).catch(enLigneSinon('Pas de connexion internet.')),
      creerCompte: (session, d) => api('/api/comptes', d, session).catch(enLigneSinon('Pas de connexion internet.')),
      majCompte: (session, id, d) => api('/api/comptes/' + encodeURIComponent(id), d, session).catch(enLigneSinon('Pas de connexion internet.')),
      changerMdp: (session, ancien, nouveau) => api('/api/moi/motdepasse', { ancien, nouveau }, session).catch(enLigneSinon('Pas de connexion internet.')),
      // Déconnecte ce poste : vérifie que tout est envoyé, désactive le poste (si administrateur), vide les données locales
      deconnecter: async (session, estAdmin) => {
        if (navigator.onLine === false) throw new Error('Pas de connexion internet : impossible de vérifier que tout a été envoyé.');
        await cycle(); if (S.enCours) await new Promise(r => setTimeout(r, 1500));
        const reste = calculer(Object.keys(COLLS)).length;
        if (reste) throw new Error(`${reste} modification(s) n'ont pas encore été envoyées au serveur. Attendez que le voyant affiche « Synchronisé », puis réessayez.`);
        if (estAdmin && S.meta.poste) await api('/api/postes/' + encodeURIComponent(S.meta.poste.id) + '/actif', { actif: false }, session).catch(() => {});
        clearTimeout(S.minuteur); S.meta = {}; IDB.file = new Map();
        await IDB.effacerTout();
        location.reload();
      },
      essaiRapports: () => api('/api/rapports/essai', {}, S.meta.jeton).catch(enLigneSinon('Pas de connexion internet.')),
      // lecture automatique de documents (bons de livraison) par l'IA, via le serveur
      ia: {
        limits: async () => ({ images: { maxCount: 5 } }),
        json: async (prompt, o = {}) => {
          const images = [];
          for (const im of o.images || []) images.push({ type: im.type || 'image/png', data: await b64(im) });
          const r = await api('/api/ia/json', { prompt, images }, S.meta.jeton).catch(enLigneSinon('Pas de connexion internet : la lecture automatique a besoin d\'internet.'));
          return r.resultat;
        },
      },
    };
    const s = document.createElement('script');
    s.textContent = src.textContent;
    document.body.appendChild(s);
    S.appLancee = true;
  }

  async function demarrer() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    try { await IDB.ouvrir(); } catch (e) {
      document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">Ce navigateur bloque le stockage local (navigation privée ?). DIOPTRA a besoin du stockage pour fonctionner hors ligne.</p>';
      return;
    }
    const tout = await IDB.toutLire();
    tout.forEach((v, k) => {
      if (k === 'meta') S.meta = v || {};
      else if (k.startsWith('ls:')) S.mem.set(k.slice(3), v);
      else if (k.startsWith('snap:')) S.snaps[k.slice(5)] = v || {};
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (!S.meta.jeton) await activer();
    // tout ce qui diffère de la version serveur sera vérifié au premier cycle
    Object.keys(COLLS).forEach(c => S.dirty.add(c));
    lancerApp();
    creerPill();
    etat(navigator.onLine === false ? 'horsligne' : 'init');
    cycle();
    window.addEventListener('online', () => cycle());
    window.addEventListener('offline', () => etat('horsligne'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) IDB.vider(); else cycle(); });
    window.addEventListener('pagehide', () => IDB.vider());
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service worker', e));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer); else demarrer();
})();
