/*
 * DIOPTRA — fusion des modifications (commune au serveur et à l'application)
 *
 * Fusion « à trois voies » : on compare la version de départ (base) connue du poste,
 * la version modifiée par le poste (local) et la version actuelle du serveur (distant).
 *  - ce que seul le poste a changé est gardé ;
 *  - ce que seul le serveur a changé est gardé ;
 *  - les listes d'éléments identifiés (id / numero) sont fusionnées élément par élément,
 *    donc deux magasins qui ajoutent chacun une vente au même client gardent les deux ventes ;
 *  - les compteurs de stock sont fusionnés par différence (+1 / -1 de chaque côté) ;
 *  - en cas de vrai conflit sur une même valeur, la dernière modification reçue gagne.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMERGE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNum = v => typeof v === 'number' && isFinite(v);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

  function eq(a, b) {
    if (a === b) return true;
    if (a === undefined || b === undefined || a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!eq(a[k], b[k])) return false;
    return true;
  }

  // Clé d'un élément de liste : id, sinon numéro de document
  const itemKey = it => isObj(it) ? (it.id != null ? 'i:' + it.id : it.numero != null ? 'n:' + it.numero : null) : null;
  const keyed = arr => Array.isArray(arr) && arr.length > 0 && arr.every(it => itemKey(it) !== null);

  // Règles de fusion par différence (compteurs) : chemin → vrai
  function deltaRule(coll, path) {
    return coll === 'produits' && /^stock\.[^.]+$/.test(path);
  }

  function m3(b, l, r, coll, path) {
    if (eq(l, b)) return clone(r);           // le poste n'a rien changé : version serveur
    if (eq(r, b)) return clone(l);           // le serveur n'a rien changé : version du poste
    if (eq(l, r)) return clone(l);
    // les deux ont changé
    if (isNum(l) && isNum(r) && deltaRule(coll, path)) return r + (l - (isNum(b) ? b : 0));
    if (isObj(l) && isObj(r)) {
      const bb = isObj(b) ? b : undefined, out = {};
      const keys = new Set([...Object.keys(r), ...Object.keys(l)]);
      for (const k of keys) {
        const inL = l[k] !== undefined, inR = r[k] !== undefined, inB = bb && bb[k] !== undefined;
        const p = path ? path + '.' + k : k;
        if (inL && inR) { const v = m3(inB ? bb[k] : undefined, l[k], r[k], coll, p); if (v !== undefined) out[k] = v; }
        else if (inL) { if (inB && eq(l[k], bb[k])) continue; out[k] = clone(l[k]); }   // supprimé côté serveur
        else if (inR) { if (inB && eq(r[k], bb[k])) continue; out[k] = clone(r[k]); }   // supprimé côté poste
      }
      return out;
    }
    if (Array.isArray(l) && Array.isArray(r) && (keyed(l) || keyed(r)) && (l.length === 0 || keyed(l)) && (r.length === 0 || keyed(r))) {
      const bArr = Array.isArray(b) ? b.filter(x => itemKey(x) !== null) : [];
      const B = new Map(bArr.map(x => [itemKey(x), x])), L = new Map(l.map(x => [itemKey(x), x])), R = new Map(r.map(x => [itemKey(x), x]));
      const order = [...R.keys()];
      for (const k of L.keys()) if (!R.has(k)) order.push(k);
      const out = [];
      for (const k of order) {
        const inL = L.has(k), inR = R.has(k), inB = B.has(k);
        if (inL && inR) out.push(m3(inB ? B.get(k) : undefined, L.get(k), R.get(k), coll, path ? path + '[]' : '[]'));
        else if (inL) { if (inB && eq(L.get(k), B.get(k))) continue; out.push(clone(L.get(k))); }
        else if (inR) { if (inB && eq(R.get(k), B.get(k))) continue; out.push(clone(R.get(k))); }
      }
      return out;
    }
    return clone(l);                          // vrai conflit : la modification reçue gagne
  }

  /**
   * Fusionne une modification envoyée par un poste avec la version du serveur.
   * @param {string} coll   nom de la collection
   * @param {*} base        version que le poste avait reçue avant de modifier (undefined si nouvelle)
   * @param {*} local       version modifiée par le poste
   * @param {*} remote      version actuelle du serveur (undefined si absente)
   */
  function merge(coll, base, local, remote) {
    if (remote === undefined) return clone(local);
    return m3(base, local, remote, coll, '');
  }

  // ---- Découpage des clés de stockage en enregistrements synchronisables ----
  // list : tableau d'éléments (id ou numéro) · map : objet clé → valeur · doc : document unique
  const COLLS = {
    clients: 'list', ventesRapides: 'list', produits: 'list', mouvements: 'list', clotures: 'list',
    mvtsStock: 'list', receptions: 'list', transferts: 'list', inventaires: 'list', bordereaux: 'list',
    verresAchat: 'list', waLog: 'list', notes: 'list', livraisons: 'list', facturesFourn: 'list', cmdCentrale: 'list', comptesBq: 'list', opsBq: 'list', reglAss: 'list', employes: 'list', conges: 'list', avances: 'list',
    pointages: 'map', paire2Mag: 'map', formation: 'map',
    parametres: 'doc', paramsAchat: 'doc', tplWa: 'doc', optVerres: 'doc', tarifs: 'doc', mappingsXL: 'doc',
    mailCaisse: 'doc', waCaisse: 'doc',
  };

  // Empreinte courte (FNV-1a) pour les éléments sans identifiant (journaux)
  function hash(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }
  const recId = it => it && it.id != null ? 'i:' + it.id : it && it.numero != null ? 'n:' + it.numero : 'h:' + hash(JSON.stringify(it));

  /** Valeur stockée (texte JSON ou texte brut) → { id: donnée } */
  function split(coll, raw) {
    const type = COLLS[coll]; const out = {};
    if (raw == null) return out;
    let v;
    if (type === 'doc') {
      try { v = JSON.parse(raw); } catch (_) { v = raw; }       // certaines clés sont du texte brut
      out._ = { v };
      return out;
    }
    try { v = JSON.parse(raw); } catch (_) { return out; }
    if (type === 'list') { if (Array.isArray(v)) v.forEach(it => { out[recId(it)] = it; }); }
    else if (type === 'map') { if (isObj(v)) Object.keys(v).forEach(k => { out[k] = { v: v[k] }; }); }
    return out;
  }
  /** { id: donnée } + ordre → valeur à stocker */
  function join(coll, recs, order) {
    const type = COLLS[coll];
    if (type === 'doc') {
      const d = recs._; if (!d) return null;
      return typeof d.v === 'string' ? d.v : JSON.stringify(d.v);
    }
    if (type === 'map') { const o = {}; Object.keys(recs).sort().forEach(k => { o[k] = recs[k].v; }); return JSON.stringify(o); }
    const ids = (order || []).filter(id => recs[id] !== undefined);
    const seen = new Set(ids);
    Object.keys(recs).forEach(id => { if (!seen.has(id)) ids.push(id); });
    return JSON.stringify(ids.map(id => recs[id]));
  }

  return { merge, eq, clone, COLLS, split, join, recId, hash };
});
