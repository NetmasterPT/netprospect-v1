#!/usr/bin/env sh
# npmplus-routes.sh — versionamento da Camada B do NPMplus (proxy hosts / routing).
# Dois métodos (env NPMPLUS_ROUTES_METHOD=api|sqlite, default sqlite por segurança):
#   • sqlite — escreve a DB SQLite direto (a UI/API é OIDC-gated para o browser). Container node:24 com a DB
#              montada (node:sqlite nativo — o host é Alpine sem node). Em `apply`, faz restart do npmplus SÓ se mudou.
#   • api    — usa a REST API do NPMplus (login local → cookie). Container node:24 com --network host (para
#              chegar a 127.0.0.1:443 do host); a API valida `nginx -t` + reload sozinha (SEM restart, SEM DB montada).
# Corre NO HOST do NPMplus.
#
#   sh npmplus-routes.sh export           # imprime routes.json da fonte (numa máquina com push: > routes.json && git commit)
#   sh npmplus-routes.sh apply            # upsert de routes.json na fonte (por domínio) + regen do nginx se mudou
#
# apply é UPSERT (cria/atualiza os domínios do routes.json; NUNCA apaga extras da UI) e idempotente.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DB_DIR="${NPMPLUS_DB_DIR:-/opt/npmplus/npmplus}"
IMG="${NODE_IMG:-node:24-slim}"
METHOD="$(printf %s "${NPMPLUS_ROUTES_METHOD:-sqlite}" | tr '[:upper:]' '[:lower:]')"

if [ "$METHOD" = "api" ]; then
  # Método API: --network host + credenciais por env. Sem DB montada, sem restart (a API regenera o nginx).
  case "${1:-}" in
    export)
      docker run --rm --network host -v "$HERE":/app:ro \
        -e NPMPLUS_ROUTES_METHOD=api -e NPMPLUS_API_URL -e NPMPLUS_API_HOST -e NPMPLUS_API_EMAIL -e NPMPLUS_API_PASSWORD \
        "$IMG" node /app/npmplus-routes.mjs export
      ;;
    apply)
      docker run --rm --network host -v "$HERE":/app:ro \
        -e NPMPLUS_ROUTES_METHOD=api -e NPMPLUS_API_URL -e NPMPLUS_API_HOST -e NPMPLUS_API_EMAIL -e NPMPLUS_API_PASSWORD \
        "$IMG" node /app/npmplus-routes.mjs apply /app/routes.json
      # A API já validou (nginx -t) e recarregou — não é preciso `docker restart npmplus`.
      ;;
    *) echo "uso: npmplus-routes.sh export | apply" >&2; exit 2 ;;
  esac
else
  # Método SQLite (default): DB montada + node:sqlite (--experimental-sqlite).
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
fi
