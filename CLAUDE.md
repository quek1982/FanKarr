# FanKarr — fork ultra.cc (quek1982)

Fork de [Masutayunikon/FanKarr](https://github.com/Masutayunikon/FanKarr) pour faire tourner FanKarr en **binaire Linux x64 autonome (sans Docker)**, servi sous **`/fankarr`** derrière le nginx d'une seedbox **ultra.cc**, avec **rTorrent** comme client.

Objectif permanent : **garder l'écart avec l'amont minimal** pour continuer à récupérer ses mises à jour. Pas de refactor ni de reformatage hors sujet ; le code ajouté suit le style du code voisin.

## Branches

- `main` : copie de `upstream/main`, jamais modifiée directement.
- Une branche par sujet, créée depuis `main`, proposée en PR à l'amont, puis fusionnée dans `ultracc` :
  - `feat/base-path` (PR #160) : variable `BASE_PATH`, service dans un sous-dossier.
  - `fix/rtorrent-xmlrpc` (PR #161) : pilote rTorrent (XML-RPC, sélection d'épisodes, torrents partiels, suppression des données, torrent terminé puis arrêté).
  - `fix/plex-server-address` (PR #162) : l'assistant Plex teste les adresses du serveur.
- `ultracc` : le build de l'utilisateur. Il fusionne les branches ci-dessus et ajoute ce qui ne part pas à l'amont :
  - suppression des données du torrent quand on supprime ses épisodes (choix volontaire, pas proposé pour l'instant) ;
  - le banc de test et les outils de déploiement (`deploy/`, `scripts/package-linux.mjs`, `scripts/update-fankarr.sh`) ;
  - ce fichier.

Une correction qui concerne l'amont va sur sa branche `fix/…` (et donc dans sa PR), jamais directement sur `ultracc`.

## Règles de travail

- L'utilisateur écrit en français : réponses, commits, PR et commentaires de code en français.
- Rien ne part à l'amont (push sur une branche de PR, nouvelle PR, commentaire) sans l'accord explicite de l'utilisateur.
- Tout correctif est validé au banc avant d'être proposé. Pour un bug, ajouter d'abord le scénario qui le reproduit, le voir échouer, puis corriger.
- Serveurs de test locaux : éviter le port 8080 (préférer 8095 et suivants).

## Build et tests

```bash
pnpm typecheck                                   # front + serveur
node scripts/package-linux.mjs                   # → release/fankarr-linux-x64.tar.gz (testé par le banc)
node deploy/e2e/gen/gen.mjs deploy/e2e/work      # une fois : données de test (non versionnées)
# + certificat de la fausse API (gen.mjs ne le crée pas ; sans lui le conteneur fakeapi s'arrête et tout échoue) :
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout deploy/e2e/work/cert/key.pem -out deploy/e2e/work/cert/cert.pem -days 365 -subj "/CN=metadata.fankai.fr" -addext "subjectAltName=DNS:metadata.fankai.fr"
docker compose -f deploy/e2e/docker-compose.yml up -d --build
node deploy/e2e/seed.mjs                         # après chaque recréation des conteneurs, sinon rien ne se télécharge
node deploy/e2e/test.mjs                         # ~10 min, 55/55 attendu
```

Le banc (ports 8097-8100) lance un vrai rTorrent, un seeder, un tracker, un faux catalogue et une fausse API metadata.fankai.fr, avec FanKarr derrière nginx sous `/fankarr`. Après une reconstruction de l'archive : `docker compose … restart fankarr proxy`.

## Publication et déploiement

- Release sur le fork, tag `v<version amont>-ultracc.N` posé sur `ultracc`, avec en pièces jointes `fankarr-linux-x64.tar.gz` et `scripts/update-fankarr.sh`.
- Sur la seedbox, FanKarr est dans `~/fankarr` et tourne sous `systemctl --user` (unité `fankarr`). Mise à jour : `bash ~/fankarr/update-fankarr.sh`, qui récupère la dernière Release ; l'ancien binaire est gardé en `fankarr.old`.
- GitHub Actions n'a jamais été activé sur le fork : une Release ne déclenche aucun des workflows de l'amont. Si on l'active, désactiver `build-binaries`, `containerize` et `release-please` sur le fork.

## Pièges connus

- rTorrent met environ 90 s à reprendre un torrent partiellement terminé après la réactivation d'un fichier : c'est son fonctionnement, pas un bug.
- Sur ultra.cc, rTorrent peut arrêter un torrent une fois terminé : un torrent complet doit être vu comme terminé même s'il est arrêté.
- Le DNS d'ultra.cc ne résout pas les noms `*.plex.direct`.
- Sous Windows, le `tar` de Git prend `C:` pour un hôte distant : lancer `tar` depuis le dossier de l'archive, avec des chemins relatifs.
- Ne jamais versionner `release/` ni `deploy/e2e/work/` (le certificat et la clé de test y sont).
