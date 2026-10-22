#!/usr/bin/env node
'use strict';
// Construit la version en ligne de DIOPTRA dans public/ à partir de web/app.html
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const R = p => path.join(__dirname, '..', p);
const OUT = R('public');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

// 1. Bibliothèques servies localement (fonctionnent hors ligne, pas de dépendance à un CDN)
const VENDOR = {
  'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js': 'web/vendor/JsBarcode.all.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js': 'web/vendor/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js': 'web/vendor/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js': 'web/vendor/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js': 'web/vendor/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js': 'web/vendor/pdf.worker.min.js',
};

let html = fs.readFileSync(R('web/app.html'), 'utf8');
const fichiers = ['/', '/index.html', '/merge.js', '/sync.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
for (const [cdn, local] of Object.entries(VENDOR)) {
  if (!html.includes(cdn)) throw new Error('Bibliothèque introuvable dans app.html : ' + cdn);
  const nom = path.basename(local);
  fs.copyFileSync(R(local), path.join(OUT, 'vendor', nom));
  html = html.split(cdn).join('/vendor/' + nom);
  fichiers.push('/vendor/' + nom);
}

// 2. Le script principal démarre après le chargement des données locales, et utilise le stockage synchronisé
const debut = html.indexOf('<script>\n(() => {');
const fin = html.indexOf('})();\n</script>', debut);
if (debut < 0 || fin < 0) throw new Error('Script principal introuvable dans app.html');
const code = html.slice(debut + '<script>'.length, fin + '})();\n'.length).replace(/\blocalStorage\./g, 'DSTORE.');
html = html.slice(0, debut) + '<script type="text/dioptra-app">' + code + '</script>' + html.slice(fin + '})();\n</script>'.length);

const sync = fs.readFileSync(R('web/sync.js'), 'utf8'), merge = fs.readFileSync(R('shared/merge.js'), 'utf8');
const version = crypto.createHash('sha256').update(html + sync + merge + fs.readFileSync(R('web/sw.js'), 'utf8')).digest('hex').slice(0, 10);

// 3. Application installable (manifeste, icônes) + chargement de la synchronisation
// app.html est un fragment (format artefact) : on l'entoure d'un document complet
html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#111111">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
` + html.replace(/<meta name="claude:[^>]*>\n?/g, '') + `
<script src="/merge.js?v=${version}"></script>
<script src="/sync.js?v=${version}"></script>
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'merge.js'), merge);
fs.writeFileSync(path.join(OUT, 'sync.js'), sync.replace(/__VERSION__/g, version));
fs.writeFileSync(path.join(OUT, 'sw.js'), fs.readFileSync(R('web/sw.js'), 'utf8').replace(/__VERSION__/g, version).replace('__FICHIERS__', JSON.stringify(fichiers)));

// 4. Manifeste et icônes
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: 'DIOPTRA', short_name: 'DIOPTRA', description: 'Logiciel de gestion pour opticiens',
  start_url: '/', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#111111', lang: 'fr',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
}, null, 2));
for (const f of ['icon.svg', 'icon-192.png', 'icon-512.png']) fs.copyFileSync(R('web/icons/' + f), path.join(OUT, 'icons', f));

console.log(`DIOPTRA construit dans public/ (version ${version})`);
