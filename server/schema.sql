-- DIOPTRA — schéma de la base PostgreSQL
-- Chaque opticien (organisation) a ses comptes, ses postes et ses données, séparés des autres.

CREATE TABLE IF NOT EXISTS organisations (
  id          text PRIMARY KEY,
  nom         text NOT NULL,
  cree_le     timestamptz NOT NULL DEFAULT now(),
  actif       boolean NOT NULL DEFAULT true
);

-- Comptes administrateurs (connexion par e-mail + mot de passe, pour activer les postes)
CREATE TABLE IF NOT EXISTS comptes (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  email       text NOT NULL UNIQUE,
  nom         text NOT NULL,
  mdp_hash    text NOT NULL,
  cree_le     timestamptz NOT NULL DEFAULT now(),
  actif       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sessions (
  jeton_hash  text PRIMARY KEY,
  compte_id   text NOT NULL REFERENCES comptes(id),
  expire_le   timestamptz NOT NULL
);

-- Postes = appareils activés (ordinateur ou tablette d'un magasin)
CREATE TABLE IF NOT EXISTS postes (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  num         integer NOT NULL,
  code        text NOT NULL,
  nom         text NOT NULL,
  magasin     text NOT NULL DEFAULT '',
  jeton_hash  text NOT NULL UNIQUE,
  cree_le     timestamptz NOT NULL DEFAULT now(),
  cree_par    text,
  vu_le       timestamptz,
  actif       boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, num),
  UNIQUE (org_id, code)
);

-- Données de l'application, découpées en enregistrements (un client, un produit, une clôture…)
CREATE SEQUENCE IF NOT EXISTS rev_seq;
CREATE TABLE IF NOT EXISTS donnees (
  org_id      text NOT NULL REFERENCES organisations(id),
  coll        text NOT NULL,
  id          text NOT NULL,
  data        jsonb,
  rev         bigint NOT NULL,
  maj_le      timestamptz NOT NULL DEFAULT now(),
  poste_id    text,
  supprime    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, coll, id)
);
CREATE INDEX IF NOT EXISTS donnees_rev ON donnees (org_id, rev);

-- Journal des envois d'e-mails (caisse quotidienne, factures)
CREATE TABLE IF NOT EXISTS envois (
  id          bigserial PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  type        text NOT NULL,
  cle         text,
  destinataires text,
  sujet       text,
  ok          boolean NOT NULL,
  erreur      text,
  le          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS envois_cle ON envois (org_id, type, cle) WHERE ok AND cle IS NOT NULL;

-- Types de comptes : administrateur (tout) ou activation (activer des postes dans certains magasins seulement)
ALTER TABLE comptes ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';
ALTER TABLE comptes ADD COLUMN IF NOT EXISTS magasins jsonb NOT NULL DEFAULT '[]';

-- Numéros de dossier atelier : un compteur par magasin (0001, 0002…), attribué par le serveur.
-- La clé (org, vente) rend la demande rejouable : un poste qui redemande reçoit le même numéro.
CREATE TABLE IF NOT EXISTS dossiers (
  org_id      text NOT NULL REFERENCES organisations(id),
  magasin     text NOT NULL,
  vente       text NOT NULL,
  num         integer NOT NULL,
  cree_le     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, vente)
);
CREATE UNIQUE INDEX IF NOT EXISTS dossiers_num ON dossiers (org_id, magasin, num);

-- Clés d'intégration : permettent à un autre logiciel (Prismea) d'envoyer des bons de livraison à DIOPTRA.
-- Seul le hachage de la clé est conservé.
CREATE TABLE IF NOT EXISTS cles_api (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organisations(id),
  nom         text NOT NULL,
  cle_hash    text NOT NULL UNIQUE,
  debut       text NOT NULL,
  cree_le     timestamptz NOT NULL DEFAULT now(),
  vu_le       timestamptz,
  actif       boolean NOT NULL DEFAULT true
);
