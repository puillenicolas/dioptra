'use strict';
// E-mails (SMTP) et lecture automatique de documents (API Claude)
const { pool } = require('./db');

// Réglages lus sans espaces ni retours à la ligne parasites (copier-coller dans Render)
const env = k => String(process.env[k] || '').trim();
let transport = null;
function mailConfigure() { return !!(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS')); }
function getTransport() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    const port = Number(env('SMTP_PORT')) || 587;
    transport = nodemailer.createTransport({
      host: env('SMTP_HOST'), port, secure: port === 465,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    });
  }
  return transport;
}

/**
 * Envoie un e-mail et le note dans le journal des envois.
 * cle : identifiant unique optionnel (évite d'envoyer deux fois le même rapport automatique)
 */
async function envoyerMail({ orgId, orgNom, type = 'manuel', cle = null, to, subject, text, html, replyTo, attachments = [] }) {
  if (!mailConfigure()) { const e = new Error('L\'envoi d\'e-mails n\'est pas encore configuré sur le serveur (réglages SMTP).'); e.status = 503; throw e; }
  const dest = (Array.isArray(to) ? to : [to]).map(x => String(x).trim()).filter(Boolean);
  const from = env('MAIL_FROM') || env('SMTP_USER');
  try {
    await getTransport().sendMail({
      from: orgNom ? `"${orgNom.replace(/"/g, '')} via DIOPTRA" <${from.replace(/^.*<|>.*$/g, '')}>` : from,
      to: dest.join(', '), replyTo: replyTo || undefined, subject, text, html,
      attachments: attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.mimeType || 'application/octet-stream' })),
    });
    await pool.query('INSERT INTO envois (org_id, type, cle, destinataires, sujet, ok) VALUES ($1,$2,$3,$4,$5,true)', [orgId, type, cle, dest.join(', '), subject]);
  } catch (e) {
    await pool.query('INSERT INTO envois (org_id, type, cle, destinataires, sujet, ok, erreur) VALUES ($1,$2,$3,$4,$5,false,$6)', [orgId, type, null, dest.join(', '), subject, String(e.message).slice(0, 500)]).catch(() => {});
    const x = new Error('Le serveur d\'e-mail a refusé l\'envoi : ' + String(e.message).slice(0, 200)); x.status = 502; throw x;
  }
}

function iaConfiguree() { return !!env('ANTHROPIC_API_KEY'); }
async function iaJson(prompt, images = []) {
  if (!iaConfiguree()) { const e = new Error('La lecture automatique n\'est pas activée sur ce serveur. Saisissez les lignes à la main ou importez un fichier Excel.'); e.status = 503; throw e; }
  const content = [
    ...images.slice(0, 5).map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type || 'image/png', data: im.data } })),
    { type: 'text', text: prompt + '\n\nRéponds uniquement avec le JSON demandé, sans texte autour.' },
  ];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Lecture automatique indisponible : ' + (j.error?.message || r.status)); e.status = 502; throw e; }
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : txt); } catch (_) { const e = new Error('Le document n\'a pas pu être lu correctement.'); e.status = 422; throw e; }
}

module.exports = { envoyerMail, mailConfigure, iaJson, iaConfiguree };
