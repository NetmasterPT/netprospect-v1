#!/usr/bin/env bash
# NetProspect — agente de AUTO-DEPLOY por PULL (Linux).
#
# Corre periodicamente (systemd timer ou cron). NÃO precisa de SSH nem de alterar a ACL do
# Tailscale: é o host que PUXA o estado do np-server. Faz git pull + puxa o seu .env do store
# central e recria os containers SÓ SE o código OU o .env mudaram (idempotente e barato).
#
# Config: copia agent.env.example → agent.env e preenche. Ver docs/runbook-laptop-autodeploy.md
# (o equivalente Windows é pull-deploy.ps1).
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF/../.." && pwd)"
CFG="$SELF/agent.env"
[ -f "$CFG" ] || { echo "falta $CFG — copia agent.env.example e preenche"; exit 1; }
set -a; . "$CFG"; set +a
LOG="$SELF/pull-deploy.log"
log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

: "${FLEET_HOST:?FLEET_HOST em falta}" ; : "${SERVER_URL:?SERVER_URL em falta}" ; : "${COMPOSE_FILE:?COMPOSE_FILE em falta}"
ENV_TARGET="${ENV_TARGET:-$REPO/$(dirname "$COMPOSE_FILE")/.env}"
changed=0

# 1) CÓDIGO — git fetch + fast-forward se atrasado.
if git -C "$REPO" fetch --quiet origin main 2>>"$LOG"; then
  L=$(git -C "$REPO" rev-parse HEAD); R=$(git -C "$REPO" rev-parse origin/main)
  if [ "$L" != "$R" ]; then
    if git -C "$REPO" pull --ff-only --quiet 2>>"$LOG"; then changed=1; log "git ${L:0:7} -> ${R:0:7}"
    else log "AVISO git pull falhou (working tree suja?) — a saltar"; fi
  fi
else log "AVISO git fetch falhou (offline?) — a saltar código"; fi

# 2) .ENV — puxa do store central; substitui só se diferente.
TMP="$(mktemp)"
if curl -fsS --max-time 20 ${FLEET_PULL_TOKEN:+-H "Authorization: Bearer $FLEET_PULL_TOKEN"} \
     "$SERVER_URL/api/fleet/pull/$FLEET_HOST" -o "$TMP" 2>>"$LOG"; then
  if [ -s "$TMP" ] && ! cmp -s "$TMP" "$ENV_TARGET"; then
    cp "$TMP" "$ENV_TARGET"; changed=1; log ".env atualizado -> $ENV_TARGET"
  fi
else log "AVISO pull do .env falhou (offline / host sem store?)"; fi
rm -f "$TMP"

# 3) RECREATE — só se algo mudou.
if [ "$changed" = 1 ]; then
  BUILD=""; [ "${COMPOSE_BUILD:-0}" = 1 ] && BUILD="--build"
  # COMPOSE_PROJECT é OBRIGATÓRIO para atingir os containers certos (sem ele o compose usa o nome
  # da pasta como projeto → cria um SEGUNDO conjunto duplicado). Ver o nome com `docker ps`.
  [ -z "${COMPOSE_PROJECT:-}" ] && { log "ERRO COMPOSE_PROJECT em falta — abortado (evita duplicar containers)"; exit 1; }
  # shellcheck disable=SC2086
  if docker compose -p "$COMPOSE_PROJECT" -f "$REPO/$COMPOSE_FILE" up -d $BUILD --force-recreate ${COMPOSE_SERVICES:-} >>"$LOG" 2>&1; then
    log "recreate OK ($COMPOSE_PROJECT / $COMPOSE_FILE)"
  else log "ERRO recreate falhou — ver acima"; fi
else log "sem alterações"; fi
