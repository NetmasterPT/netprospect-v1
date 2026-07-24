#!/usr/bin/env sh
# npmplus-routes.sh — versionamento da Camada B do NPMplus (proxy hosts / routing) via SQLite direto.
# A UI/API do NPMplus é OIDC-gated → escrevemos a DB. Wrapper do npmplus-routes.mjs num container
# node:24 (node:sqlite nativo — o host é Alpine sem node). Corre NO HOST do NPMplus.
#
#   sh npmplus-routes.sh export           # imprime routes.json da DB (numa máquina com push: > routes.json && git commit)
#   sh npmplus-routes.sh apply            # upsert de routes.json na DB (por domínio) + regen do nginx se mudou
#
# apply é UPSERT (cria/atualiza os domínios do routes.json; NUNCA apaga extras da UI) e idempotente.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DB_DIR="${NPMPLUS_DB_DIR:-/opt/npmplus/npmplus}"
IMG="${NODE_IMG:-node:24-slim}"

case "${1:-}" in
  export)
    docker run --rm -v "$DB_DIR":/db:ro -v "$HERE":/app:ro -e NPMPLUS_DB=/db/database.sqlite \
      "$IMG" node --experimental-sqlite /app/npmplus-routes.mjs export
    ;;
  apply)
    OUT=$(docker run --rm -v "$DB_DIR":/db -v "$HERE":/app:ro -e NPMPLUS_DB=/db/database.sqlite \
      "$IMG" node --experimental-sqlite /app/npmplus-routes.mjs apply /app/routes.json 2>&1)
    echo "$OUT"
    if echo "$OUT" | grep -q '^CHANGED'; then
      # A DB mudou → o NPMplus tem de regenerar os confs do nginx (fá-lo no arranque a partir da DB).
      docker restart npmplus >/dev/null 2>&1 && echo "nginx regenerado (restart npmplus)"
    fi
    ;;
  *) echo "uso: npmplus-routes.sh export | apply" >&2; exit 2 ;;
esac
