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
# Telemetria de host (opcional) — alvos de latência e opt-out. Sob `set -u` têm de ter default.
DIRECTUS_PING_URL="${DIRECTUS_PING_URL:-}"; MINIO_HEALTH_URL="${MINIO_HEALTH_URL:-}"
PG_HOST="${PG_HOST:-}"; PG_PORT="${PG_PORT:-5432}"; METRICS_ENABLED="${METRICS_ENABLED:-1}"
changed=0

# 1) CÓDIGO — git fetch + fast-forward se atrasado. SKIP_GIT=1 salta (ex.: hel1, que é onde se
# committa e tem sempre o working tree à frente → não faz sentido puxar).
if [ "${SKIP_GIT:-0}" = 1 ]; then
  log "git: saltado (SKIP_GIT=1)"
elif git -C "$REPO" fetch --quiet origin main 2>>"$LOG"; then
  L=$(git -C "$REPO" rev-parse HEAD); R=$(git -C "$REPO" rev-parse origin/main)
  if [ "$L" != "$R" ]; then
    # Guarda docs-only: se TODOS os ficheiros alterados forem .md (docs/, raiz, …), faz o pull na
    # mesma mas NÃO recria (documentação nunca é carregada pelos workers → recreate seria churn inútil).
    FILES=$(git -C "$REPO" diff --name-only "$L" "$R" 2>>"$LOG")
    if git -C "$REPO" pull --ff-only --quiet 2>>"$LOG"; then
      if printf '%s\n' "$FILES" | grep -qvE '\.md$'; then changed=1; log "git ${L:0:7} -> ${R:0:7}"
      else log "git ${L:0:7} -> ${R:0:7} (só docs .md — sem recreate)"; fi
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

# 4) TELEMETRIA DE HOST — snapshot a cada ciclo (mesmo sem recreate) → POST ao dashboard.
#    Fonte: /proc (CPU/RAM/disco/IO/rede) + latências (Directus/PG/NAS). Falha-suave (só regista).
#    Em LXC (ex.: hel1) o /proc é do host da máquina, não do contentor — igual ao load já reportado.
net_bytes()     { awk 'NR>2 && $1!~/^lo:/ {gsub(/:/,"",$1); rx+=$2; tx+=$10} END{printf "%d %d", rx+0, tx+0}' /proc/net/dev 2>/dev/null; }
disk_sectors()  { awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/ {r+=$6; w+=$10} END{printf "%d %d", r+0, w+0}' /proc/diskstats 2>/dev/null; }
http_ms()       { [ -z "$1" ] && return 0; local t; t=$(curl -fsS --max-time 5 -o /dev/null -w '%{time_total}' "$1" 2>/dev/null) || return 0; awk "BEGIN{printf \"%.0f\", $t*1000}"; }
tcp_ms()        { { [ -z "$1" ] || [ -z "$2" ]; } && return 0; local s e; s=$(date +%s%N); if timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then e=$(date +%s%N); exec 3>&- 2>/dev/null; awk "BEGIN{printf \"%.0f\", ($e-$s)/1000000}"; fi; }
collect_metrics() {
  # CPU: 2 amostras de /proc/stat (~1s). rede/disco: delta na mesma janela → taxas MB/s.
  read -r _ u1 n1 s1 i1 w1 x1 y1 z1 _ < /proc/stat
  local idle1=$((i1 + w1)) tot1=$((u1 + n1 + s1 + i1 + w1 + x1 + y1 + z1))
  local rx1 tx1 dr1 dw1; read -r rx1 tx1 < <(net_bytes); read -r dr1 dw1 < <(disk_sectors)
  sleep 1
  read -r _ u2 n2 s2 i2 w2 x2 y2 z2 _ < /proc/stat
  local idle2=$((i2 + w2)) tot2=$((u2 + n2 + s2 + i2 + w2 + x2 + y2 + z2))
  local rx2 tx2 dr2 dw2; read -r rx2 tx2 < <(net_bytes); read -r dr2 dw2 < <(disk_sectors)
  local dtot=$((tot2 - tot1)) didle=$((idle2 - idle1)) cpu=0
  [ "$dtot" -gt 0 ] && cpu=$(awk "BEGIN{printf \"%.1f\", 100*($dtot-$didle)/$dtot}")
  local net_rx net_tx io_read io_write
  net_rx=$(awk "BEGIN{printf \"%.2f\", ($rx2-$rx1)/1048576}"); net_tx=$(awk "BEGIN{printf \"%.2f\", ($tx2-$tx1)/1048576}")
  io_read=$(awk "BEGIN{printf \"%.2f\", ($dr2-$dr1)*512/1048576}"); io_write=$(awk "BEGIN{printf \"%.2f\", ($dw2-$dw1)*512/1048576}")
  # RAM (MB) + disco / (GB) + load + cores + uptime.
  local memt mema mem_total mem_used
  memt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo); mema=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  mem_total=$((memt / 1024)); mem_used=$(((memt - mema) / 1024))
  local disk_total disk_used; read -r disk_total disk_used < <(df -P -k / | awk 'NR==2{printf "%.0f %.0f", $2/1048576, $3/1048576}')
  local load cores uptime
  load=$(awk '{print $1}' /proc/loadavg); cores=$(nproc 2>/dev/null || echo 0); uptime=$(awk '{printf "%d", $1}' /proc/uptime)
  # Latências (ms) — opcionais (vazias se o alvo não estiver configurado).
  local lat_directus lat_pg lat_minio
  lat_directus=$(http_ms "$DIRECTUS_PING_URL"); lat_minio=$(http_ms "$MINIO_HEALTH_URL"); lat_pg=$(tcp_ms "$PG_HOST" "$PG_PORT")
  local body
  body=$(printf '{"cpu":%s,"load":%s,"cores":%s,"mem_used":%s,"mem_total":%s,"disk_used":%s,"disk_total":%s,"io_read":%s,"io_write":%s,"net_rx":%s,"net_tx":%s,"uptime":%s%s%s%s}' \
    "$cpu" "${load:-0}" "${cores:-0}" "$mem_used" "$mem_total" "$disk_used" "$disk_total" "$io_read" "$io_write" "$net_rx" "$net_tx" "$uptime" \
    "${lat_directus:+,\"lat_directus\":$lat_directus}" "${lat_pg:+,\"lat_pg\":$lat_pg}" "${lat_minio:+,\"lat_minio\":$lat_minio}")
  if curl -fsS --max-time 15 -X POST ${FLEET_PULL_TOKEN:+-H "Authorization: Bearer $FLEET_PULL_TOKEN"} \
       -H "Content-Type: application/json" -d "$body" "$SERVER_URL/api/fleet/metrics/$FLEET_HOST" -o /dev/null 2>>"$LOG"; then
    log "métricas enviadas (cpu ${cpu}% ram ${mem_used}/${mem_total}MB disco ${disk_used}/${disk_total}GB)"
  else log "AVISO envio de métricas falhou"; fi
}
[ "$METRICS_ENABLED" = 1 ] && collect_metrics
