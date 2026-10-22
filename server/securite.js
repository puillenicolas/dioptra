'use strict';
const crypto = require('crypto');

// Mots de passe : scrypt avec sel aléatoire
function hacherMdp(mdp) {
  const sel = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(mdp), sel, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sel.toString('base64')}$${h.toString('base64')}`;
}
function verifierMdp(mdp, stocke) {
  const [algo, s, h] = String(stocke || '').split('$');
  if (algo !== 'scrypt' || !s || !h) return false;
  const attendu = Buffer.from(h, 'base64');
  const calc = crypto.scryptSync(String(mdp), Buffer.from(s, 'base64'), attendu.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(attendu, calc);
}

// Jetons (postes et sessions) : seul le hachage est conservé en base
const nouveauJeton = () => crypto.randomBytes(32).toString('base64url');
const hacherJeton = j => crypto.createHash('sha256').update(String(j)).digest('hex');
const nouvelId = (p = '') => p + crypto.randomBytes(9).toString('base64url');

module.exports = { hacherMdp, verifierMdp, nouveauJeton, hacherJeton, nouvelId };
