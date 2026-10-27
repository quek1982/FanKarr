#!/usr/bin/env bash
# Met à jour FanKarr sur la seedbox depuis la dernière Release de quek1982/FanKarr.
#   bash ~/fankarr/update-fankarr.sh
# Ne touche ni au .env ni à la configuration : seuls le binaire, le worker et public/ sont remplacés.
set -euo pipefail

DIR="${FANKARR_DIR:-$HOME/fankarr}"
SERVICE="${FANKARR_SERVICE:-fankarr}"
URL="https://github.com/quek1982/FanKarr/releases/latest/download/fankarr-linux-x64.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Téléchargement de la dernière version…"
curl -fL --progress-bar -o "$TMP/fankarr.tar.gz" "$URL"
tar -xzf "$TMP/fankarr.tar.gz" -C "$TMP"
NEW="$TMP/fankarr-linux-x64"
[ -f "$NEW/fankarr" ] || { echo "Archive inattendue : fankarr absent" >&2; exit 1; }

echo "Arrêt de $SERVICE…"
systemctl --user stop "$SERVICE"

# Ancien binaire gardé pour revenir en arrière : mv fankarr.old fankarr
[ -f "$DIR/fankarr" ] && cp -p "$DIR/fankarr" "$DIR/fankarr.old"
cp "$NEW/fankarr" "$NEW/organize-worker.js" "$NEW/version.txt" "$NEW/.env.example" "$DIR/"
chmod +x "$DIR/fankarr"
# Les noms des fichiers du front changent à chaque build : on repart d'un dossier propre
rm -rf "$DIR/public"
cp -r "$NEW/public" "$DIR/public"

echo "Redémarrage de $SERVICE…"
systemctl --user start "$SERVICE"
sleep 2
systemctl --user --no-pager --lines=5 status "$SERVICE" || true
