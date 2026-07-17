#!/usr/bin/env bash
# NetProspect — reporter de telemetria de host STANDALONE.
#
# Para máquinas de INFRA que NÃO têm o repo nem Docker (ex.: np-db — Postgres nativo num CT) e por
# isso não podem correr o pull-deploy.sh. Recolhe /proc (CPU/RAM/disco/IO/rede) + latências e faz
# POST ao dashboard (mesmo formato que o passo de métricas do pull-deploy.sh). Sem git, sem recreate.
# Se houver Docker, também reporta os containers (guardado). Corre por um systemd timer (~5 min).
#
# Config: /etc/netprospect-metrics.env (ou METRICS_ENV=<path>). Ver metrics.env.example.
set -uo pipefail
CFG="${METRICS_ENV:-/etc/netprospect-metrics.env}"
# shellcheck disable=SC1090
[ -f "$CFG" ] && { set -a; . "$CFG"; set +a; }
: "${FLEET_HOST:?FLEET_HOST em falta}" ; : "${SERVER_URL:?SERVER_URL em falta}"
DIRECTUS_PING_URL="${DIRECTUS_PING_URL:-}"; MINIO_HEALTH_URL="${MINIO_HEALTH_URL:-}"
PG_HOST="${PG_HOST:-}"; PG_PORT="${PG_PORT:-5432}"; FLEET_PULL_TOKEN="${FLEET_PULL_TOKEN:-}"

net_bytes()     { awk 'NR>2 && $1!~/^lo:/ {gsub(/:/,"",$1); rx+=$2; tx+=$10} END{printf "%d %d", rx+0, tx+0}' /proc/net/dev 2>/dev/null; }
disk_sectors()  { awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/ {r+=$6; w+=$10} END{printf "%d %d", r+0, w+0}' /proc/diskstats 2>/dev/null; }
containers_json() { command -v docker >/dev/null 2>&1 || { printf '[]'; return; }; docker ps --format '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null | awk -F'\t' 'BEGIN{printf "["}{if(NR>1)printf ",";for(i=1;i<=5;i++)gsub(/["\\]/,"",$i);printf "{\"name\":\"%s\",\"state\":\"%s\",\"status\":\"%s\",\"image\":\"%s\",\"ports\":\"%s\"}",$1,$2,$3,$4,$5}END{printf "]"}'; }
http_ms()       { [ -z "$1" ] && return 0; local t; t=$(curl -fsS --max-time 5 -o /dev/null -w '%{time_total}' "$1" 2>/dev/null) || return 0; awk "BEGIN{printf \"%.0f\", $t*1000}"; }
tcp_ms()        { { [ -z "$1" ] || [ -z "$2" ]; } && return 0; local s e; s=$(date +%s%N); if timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then e=$(date +%s%N); exec 3>&- 2>/dev/null; awk "BEGIN{printf \"%.0f\", ($e-$s)/1000000}"; fi; }

read -r _ u1 n1 s1 i1 w1 x1 y1 z1 _ < /proc/stat
idle1=$((i1 + w1)); tot1=$((u1 + n1 + s1 + i1 + w1 + x1 + y1 + z1))
read -r rx1 tx1 < <(net_bytes); read -r dr1 dw1 < <(disk_sectors)
sleep 1
read -r _ u2 n2 s2 i2 w2 x2 y2 z2 _ < /proc/stat
idle2=$((i2 + w2)); tot2=$((u2 + n2 + s2 + i2 + w2 + x2 + y2 + z2))
read -r rx2 tx2 < <(net_bytes); read -r dr2 dw2 < <(disk_sectors)
dtot=$((tot2 - tot1)); didle=$((idle2 - idle1)); cpu=0
[ "$dtot" -gt 0 ] && cpu=$(awk "BEGIN{printf \"%.1f\", 100*($dtot-$didle)/$dtot}")
net_rx=$(awk "BEGIN{printf \"%.2f\", ($rx2-$rx1)/1048576}"); net_tx=$(awk "BEGIN{printf \"%.2f\", ($tx2-$tx1)/1048576}")
io_read=$(awk "BEGIN{printf \"%.2f\", ($dr2-$dr1)*512/1048576}"); io_write=$(awk "BEGIN{printf \"%.2f\", ($dw2-$dw1)*512/1048576}")
memt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo); mema=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mem_total=$((memt / 1024)); mem_used=$(((memt - mema) / 1024))
read -r disk_total disk_used < <(df -P -k / | awk 'NR==2{printf "%.0f %.0f", $2/1048576, $3/1048576}')
load=$(awk '{print $1}' /proc/loadavg); cores=$(nproc 2>/dev/null || echo 0); uptime=$(awk '{printf "%d", $1}' /proc/uptime)
lat_directus=$(http_ms "$DIRECTUS_PING_URL"); lat_minio=$(http_ms "$MINIO_HEALTH_URL"); lat_pg=$(tcp_ms "$PG_HOST" "$PG_PORT")
containers=$(containers_json)
body=$(printf '{"cpu":%s,"load":%s,"cores":%s,"mem_used":%s,"mem_total":%s,"disk_used":%s,"disk_total":%s,"io_read":%s,"io_write":%s,"net_rx":%s,"net_tx":%s,"uptime":%s,"containers":%s%s%s%s}' \
  "$cpu" "${load:-0}" "${cores:-0}" "$mem_used" "$mem_total" "$disk_used" "$disk_total" "$io_read" "$io_write" "$net_rx" "$net_tx" "$uptime" "$containers" \
  "${lat_directus:+,\"lat_directus\":$lat_directus}" "${lat_pg:+,\"lat_pg\":$lat_pg}" "${lat_minio:+,\"lat_minio\":$lat_minio}")
curl -fsS --max-time 15 -X POST ${FLEET_PULL_TOKEN:+-H "Authorization: Bearer $FLEET_PULL_TOKEN"} \
  -H "Content-Type: application/json" -d "$body" "$SERVER_URL/api/fleet/metrics/$FLEET_HOST" -o /dev/null \
  && echo "métricas enviadas ($FLEET_HOST: cpu ${cpu}% ram ${mem_used}/${mem_total}MB)" \
  || { echo "envio de métricas falhou" >&2; exit 1; }
