# DIOPTRA

Logiciel de gestion pour opticiens : clients, ventes et devis lunettes et lentilles, caisse, stock, comptabilité, prises en charge.
Version en ligne multi-magasins, qui **continue de fonctionner sans internet**.

---

## Comment ça marche

```
 Poste magasin (navigateur)                         Serveur (Render)
 ┌─────────────────────────────┐                    ┌──────────────────────────┐
 │ DIOPTRA (web/app.html)      │                    │ API Node.js (server/)    │
 │ données sur le poste        │ ◄── synchro ──►    │ PostgreSQL               │
 │ (IndexedDB) + file d'envoi  │   dès qu'internet  │ e-mails (SMTP)           │
 │ application installable     │   est disponible   │ rapport de caisse du soir│
 └─────────────────────────────┘                    └──────────────────────────┘
```

- **Hors ligne** : chaque poste garde une copie complète des données. Ventes, encaissements et clôtures se font sans internet.
  Les modifications partent automatiquement au retour de la connexion. L'indicateur en bas à gauche de l'écran affiche l'état de la synchronisation.
- **Plusieurs postes en même temps** : les modifications sont fusionnées. Deux magasins qui ajoutent chacun une vente au même client gardent les deux ventes,
  et les mouvements de stock s'additionnent (`shared/merge.js`).
- **Numéros de facture uniques**, même hors ligne : chaque poste a son code (ex. `FA-LBV1-2026-0001`).
- **Plusieurs opticiens** : chaque opticien a ses propres comptes, postes et données. Aucun ne voit les données d'un autre.
- **Sécurité** : les mots de passe et les codes PIN sont enregistrés sous forme d'empreinte, jamais en clair. Chaque poste a son propre jeton d'accès, révocable depuis Paramètres › Postes.

## Structure

| Dossier | Contenu |
|---|---|
| `web/app.html` | L'application (même fichier que l'aperçu Claude) |
| `web/sync.js` | Stockage local, synchronisation, écran d'activation d'un poste |
| `web/sw.js` | Service worker : l'application s'ouvre sans internet |
| `shared/merge.js` | Fusion des modifications (serveur et postes) |
| `server/` | API, base de données, e-mails, rapport de caisse automatique |
| `scripts/build.js` | Construit `public/` (version servie en ligne) |
| `scripts/creer-opticien.js` | Crée un opticien et son compte administrateur |

---

## Mise en ligne pas à pas

### 1. GitHub (stockage du code)
1. Créer un compte sur <https://github.com>.
2. Créer un dépôt **privé** nommé `dioptra`.
3. Y envoyer ce dossier (ou connecter GitHub à Claude pour qu'il s'en charge).

### 2. Render (serveur et base de données)
1. Créer un compte sur <https://render.com> et enregistrer une carte bancaire.
2. **New › Blueprint**, choisir le dépôt `dioptra`. Render lit `render.yaml` et crée :
   - le serveur `dioptra` (offre Starter) ;
   - la base `dioptra-db` (PostgreSQL 1 Go).
   Les deux sont en région Frankfurt, la plus proche du Gabon parmi les régions Render.
3. Dans **dioptra › Environment**, renseigner les réglages e-mail (voir l'étape 4).
4. Attendre la fin du déploiement : l'adresse `https://dioptra-xxxx.onrender.com` répond.

### 3. Créer le compte Fashion Vision
Dans Render, ouvrir **dioptra › Shell** et taper :

```bash
npm run creer-opticien -- "Fashion Vision" votre@email.com "UnMotDePasseSolide" "Nicolas Puille"
```

Ouvrir ensuite l'adresse du site sur le premier poste et se connecter avec cet e-mail et ce mot de passe.
Donner le nom du premier magasin et le code du poste, puis créer son code PIN à 6 chiffres.
Les autres magasins, utilisateurs et listes se règlent ensuite dans **Paramètres**.

### 4. E-mails
Il faut un service d'envoi SMTP. Deux possibilités simples :
- **Brevo** (300 e-mails par jour gratuits) : `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, identifiant et clé SMTP fournis par Brevo.
- **Gmail** (avec un mot de passe d'application) : `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=adresse Gmail`, `SMTP_PASS=mot de passe d'application`.

`MAIL_FROM` est l'expéditeur affiché, par exemple `DIOPTRA <no-reply@dioptra-app.com>`.
L'e-mail de caisse du soir se règle dans **Paramètres › Général** : heure d'envoi, destinataires par magasin et destinataires du récapitulatif. Le bouton « Envoyer un essai maintenant » permet de tester.

### 5. Nom de domaine
Acheter le domaine (ex. `dioptra-app.com`), puis dans Render : **dioptra › Settings › Custom Domains**.
Ajouter le domaine et recopier chez le registraire l'enregistrement DNS indiqué. Le certificat HTTPS est automatique.

### 6. Installer DIOPTRA sur chaque poste
Ouvrir le site dans Chrome ou Edge, puis cliquer sur **Installer** dans la barre d'adresse.
DIOPTRA s'ouvre alors comme une application et fonctionne même quand internet est coupé.

---

## Lecture automatique des bons de livraison (facultatif)
Renseigner `ANTHROPIC_API_KEY` (clé API Claude, payante à l'usage) dans Render. Sans clé, le bouton indique que la lecture automatique n'est pas activée. L'import Excel ou CSV reste disponible.

## Ajouter un autre opticien (vente du logiciel)
Même commande que l'étape 3 avec ses informations, ou l'appel API protégé par `ADMIN_KEY` :

```bash
curl -X POST https://votre-domaine/api/admin/organisations \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"nom":"Optique X","email":"gerant@optiquex.ga","motdepasse":"…","nomAdmin":"Prénom Nom"}'
```

## Développement local

```bash
npm install
cp .env.example .env          # puis adapter DATABASE_URL
npm run build && npm start    # http://localhost:3000
npm test                      # tests du serveur et du rapport de caisse
```

L'aperçu Claude (artefact) utilise `web/app.html` tel quel, avec un stockage dans le navigateur et sans serveur.
