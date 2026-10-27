#!/bin/sh
# Copie le paquet monté en lecture seule (release/fankarr-linux-x64), comme une extraction de l'archive
set -e
rm -rf /app && cp -r /pkg /app
chmod +x /app/fankarr
printf 'BASE_PATH=%s\nPORT=%s\n' "${TEST_BASE_PATH:-/fankarr}" "${TEST_PORT:-9898}" > /app/.env
exec /app/fankarr
