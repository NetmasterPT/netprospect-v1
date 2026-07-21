#!/usr/bin/env bash
# NetProspect — auto-deploy por PULL do reverse-proxy NPMplus (CT hel1-npm, VMID 103).
#
# Corre por cron/timer NA BOX hel1-npm. Faz `git pull` do repo e — SÓ SE deploy/npmplus/ mudou —
# copia o compose para /opt/compose.yaml e faz `docker compose up -d`. SEM --force-recreate: o
# compose só recria o(s) serviço(s) cujo config REALMENTE mudou; o resto do proxy fica up (sem
# downtime). Valida o config ANTES de aplicar → um compose inválido/segredo em falta aborta sem
# derrubar o proxy. Idempotente e barato (no-op quando nada mudou).
#
# Segredos: /opt/.env (fora do git, NUNCA sai da box). Ver deploy/npmplus/README.md.
# Rollback: `cp /opt/compose.yaml.bak /opt/compose.yaml && docker compose --project-directory /opt \
#   -f /opt/compose.yaml --env-file /opt/.env up -d`, ou restaurar o CT via PBS.
set -uo pipefail
REPO="${NPMPLUS_REPO:-/opt/netprospect-v1}"
SRC="$REPO/deploy/npmplus/compose.yaml"
LIVE="/opt/compose.yaml"
ENVF="/opt/.env"
LOG="/opt/npmplus-deploy.log"
log(){ printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }
dc(){ docker compose --project-directory /opt -f "$LIVE" --env-file "$ENVF" "$@"; }

[ -f "$ENVF" ] || { log "ERRO $ENVF em falta (segredos) — abortado"; exit 1; }
[ -f "$SRC" ]  || { log "ERRO $SRC em falta (repo clonado em $REPO?) — abortado"; exit 1; }

changed=0
# 1) CÓDIGO — git fetch + fast-forward. Só conta como alteração se mexeu em deploy/npmplus/
#    (qualquer outro commit da frota faz pull na mesma mas não recria — evita churn no proxy).
if git -C "$REPO" fetch --quiet origin main 2>>"$LOG"; then
  L=$(git -C "$REPO" rev-parse HEAD); R=$(git -C "$REPO" rev-parse origin/main)
  if [ "$L" != "$R" ]; then
    FILES=$(git -C "$REPO" diff --name-only "$L" "$R")
    if git -C "$REPO" pull --ff-only --quiet 2>>"$LOG"; then
      if printf '%s\n' "$FILES" | grep -q '^deploy/npmplus/'; then changed=1; log "git ${L:0:7}->${R:0:7} (npmplus mudou)"
      else log "git ${L:0:7}->${R:0:7} (sem npmplus)"; fi
    else log "AVISO git pull falhou (working tree suja?) — a saltar"; fi
  fi
else log "AVISO git fetch falhou (offline?) — a saltar"; fi

# 2) DRIFT — se o compose do repo difere do vivo (1ª aplicação / edição manual), também aplica.
cmp -s "$SRC" "$LIVE" 2>/dev/null || changed=1

# 3) APLICAR — só se algo mudou.
if [ "$changed" = 1 ]; then
  cp "$LIVE" "$LIVE.bak" 2>/dev/null   # backup do vivo antes de sobrepor (rollback rápido)
  cp "$SRC" "$LIVE"
  if ! dc config >/dev/null 2>>"$LOG"; then
    log "ERRO compose config inválido (segredo em falta?) — deploy ABORTADO, proxy intacto"
    cp "$LIVE.bak" "$LIVE" 2>/dev/null   # reverte o /opt/compose.yaml para o que estava a correr
    exit 1
  fi
  if dc up -d >>"$LOG" 2>&1; then log "deploy OK"; else log "ERRO up -d falhou — ver acima"; fi
else log "sem alterações"; fi
