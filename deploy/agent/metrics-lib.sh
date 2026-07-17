#!/usr/bin/env bash
# NetProspect — biblioteca partilhada de recolha de telemetria de host (sourceada por pull-deploy.sh e
# metrics-report.sh). Recolhe /proc (CPU/RAM/disco/IO/rede) + latências + Docker (containers) + systemd
# (serviços do sistema base como pseudo-containers) e faz POST /api/fleet/metrics/<FLEET_HOST>.
#
# Requer no ambiente: FLEET_HOST, SERVER_URL. Opcionais: FLEET_PULL_TOKEN, DIRECTUS_PING_URL,
# MINIO_HEALTH_URL, PG_HOST/PG_PORT, REPORT_SERVICES (lista; vazio = auto-descoberta), METRICS_DRYRUN=1
# (imprime o JSON em vez de POST).
# NÃO tem shebang de execução própria — é para `source`.

esc_json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
net_bytes()    { awk 'NR>2 && $1!~/^lo:/ {gsub(/:/,"",$1); rx+=$2; tx+=$10} END{printf "%d %d", rx+0, tx+0}' /proc/net/dev 2>/dev/null; }
disk_sectors() { awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/ {r+=$6; w+=$10} END{printf "%d %d", r+0, w+0}' /proc/diskstats 2>/dev/null; }
http_ms()      { [ -z "$1" ] && return 0; local t; t=$(curl -fsS --max-time 5 -o /dev/null -w '%{time_total}' "$1" 2>/dev/null) || return 0; awk "BEGIN{printf \"%.0f\", $t*1000}"; }
tcp_ms()       { { [ -z "$1" ] || [ -z "$2" ]; } && return 0; local s e; s=$(date +%s%N); if timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then e=$(date +%s%N); exec 3>&- 2>/dev/null; awk "BEGIN{printf \"%.0f\", ($e-$s)/1000000}"; fi; }

# Containers Docker → pseudo-unidades (kind=container). id = id do container = HOSTNAME = id do worker.
containers_json() {
  command -v docker >/dev/null 2>&1 || { printf '[]'; return; }
  declare -A ST
  while IFS=$'\t' read -r cid cpu mem net blk; do ST["$cid"]="$cpu|$mem|$net|$blk"; done < <(docker stats --no-stream --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}' 2>/dev/null)
  local first=1 cid name state status image ports s cpu mem net blk logb64
  printf '['
  while IFS=$'\t' read -r cid name state status image ports; do
    s="${ST[$cid]:-|||}"; IFS='|' read -r cpu mem net blk <<< "$s"
    logb64=$(docker logs --tail 14 "$cid" 2>&1 | tail -c 4000 | base64 -w0 2>/dev/null)
    [ "$first" = 1 ] && first=0 || printf ','
    printf '{"kind":"container","id":"%s","name":"%s","state":"%s","status":"%s","image":"%s","ports":"%s","cpu":"%s","mem":"%s","net":"%s","blk":"%s","logb64":"%s"}' \
      "$(esc_json "$cid")" "$(esc_json "$name")" "$(esc_json "$state")" "$(esc_json "$status")" "$(esc_json "$image")" "$(esc_json "$ports")" \
      "$(esc_json "$cpu")" "$(esc_json "$mem")" "$(esc_json "$net")" "$(esc_json "$blk")" "$logb64"
  done < <(docker ps --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null)
  printf ']'
}

# Lista de serviços systemd a reportar: REPORT_SERVICES (env, separado por espaços) ou auto-descoberta
# (unidades .service a correr, menos ruído de sistema). Máx 25.
service_list() {
  if [ -n "${REPORT_SERVICES:-}" ]; then printf '%s\n' ${REPORT_SERVICES}; return; fi
  systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | sed 's/\.service$//' \
    | grep -vE '^(systemd-|user@|user-runtime|session-|dbus|polkit|getty@|serial-getty@|console-|emergency|rescue|dracut|kmod|ldconfig|apt-daily|man-db|e2scrub|fstrim|logrotate|motd|snapd\.seeded|networkd-dispatcher|multipathd|unattended|packagekit|accounts-daemon|rtkit|udisks| modprobe|cloud-|qemu-guest)' | head -25
}

# Serviços systemd → pseudo-unidades (kind=service). RAM=MemoryCurrent (atual), CPU=CPUUsageNSec (acumulado
# → segundos), logs=journalctl. id "svc:<nome>" (não colide com ids de container).
services_json() {
  command -v systemctl >/dev/null 2>&1 || { printf '[]'; return; }
  local first=1 svc active sub memb cpuns desc cpusec logb64 k v
  printf '['
  for svc in $(service_list); do
    active=""; sub=""; memb=""; cpuns=""; desc=""
    while IFS='=' read -r k v; do case "$k" in
      ActiveState) active=$v ;; SubState) sub=$v ;; MemoryCurrent) memb=$v ;; CPUUsageNSec) cpuns=$v ;; Description) desc=$v ;;
    esac; done < <(systemctl show "$svc.service" -p ActiveState -p SubState -p MemoryCurrent -p CPUUsageNSec -p Description 2>/dev/null)
    { [ -z "$active" ] || [ "$active" = "not-found" ]; } && continue
    case "$memb" in ''|*[!0-9]*|18446744073709551615) memb="" ;; esac
    cpusec=""; case "$cpuns" in ''|*[!0-9]*) ;; *) cpusec=$((cpuns / 1000000000)) ;; esac
    logb64=$(journalctl -u "$svc.service" -n 14 --no-pager -o cat 2>/dev/null | tail -c 4000 | base64 -w0 2>/dev/null)
    [ "$first" = 1 ] && first=0 || printf ','
    printf '{"kind":"service","id":"svc:%s","name":"%s","state":"%s","status":"%s","image":"%s","memb":"%s","cpuSec":"%s","logb64":"%s"}' \
      "$(esc_json "$svc")" "$(esc_json "$svc")" "$(esc_json "$active")" "$(esc_json "$sub")" "$(esc_json "$desc")" "$(esc_json "$memb")" "$(esc_json "$cpusec")" "$logb64"
  done
  printf ']'
}

# Junta dois arrays JSON "[...]" num só.
merge_json_arrays() {
  local ai="${1#[}"; ai="${ai%]}"; local bi="${2#[}"; bi="${bi%]}"
  if [ -z "$ai" ] && [ -z "$bi" ]; then printf '[]';
  elif [ -z "$ai" ]; then printf '[%s]' "$bi";
  elif [ -z "$bi" ]; then printf '[%s]' "$ai";
  else printf '[%s,%s]' "$ai" "$bi"; fi
}

# Recolhe tudo e faz POST (ou imprime se METRICS_DRYRUN=1). Devolve 0/1.
collect_and_post() {
  : "${FLEET_HOST:?}"; : "${SERVER_URL:?}"
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
  local memt mema mem_total mem_used disk_total disk_used load cores uptime
  memt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo); mema=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  mem_total=$((memt / 1024)); mem_used=$(((memt - mema) / 1024))
  read -r disk_total disk_used < <(df -P -k / | awk 'NR==2{printf "%.0f %.0f", $2/1048576, $3/1048576}')
  load=$(awk '{print $1}' /proc/loadavg); cores=$(nproc 2>/dev/null || echo 0); uptime=$(awk '{printf "%d", $1}' /proc/uptime)
  local lat_directus lat_pg lat_minio units
  lat_directus=$(http_ms "${DIRECTUS_PING_URL:-}"); lat_minio=$(http_ms "${MINIO_HEALTH_URL:-}"); lat_pg=$(tcp_ms "${PG_HOST:-}" "${PG_PORT:-5432}")
  units=$(merge_json_arrays "$(containers_json)" "$(services_json)")
  local body
  body=$(printf '{"cpu":%s,"load":%s,"cores":%s,"mem_used":%s,"mem_total":%s,"disk_used":%s,"disk_total":%s,"io_read":%s,"io_write":%s,"net_rx":%s,"net_tx":%s,"uptime":%s,"containers":%s%s%s%s}' \
    "$cpu" "${load:-0}" "${cores:-0}" "$mem_used" "$mem_total" "$disk_used" "$disk_total" "$io_read" "$io_write" "$net_rx" "$net_tx" "$uptime" "$units" \
    "${lat_directus:+,\"lat_directus\":$lat_directus}" "${lat_pg:+,\"lat_pg\":$lat_pg}" "${lat_minio:+,\"lat_minio\":$lat_minio}")
  if [ "${METRICS_DRYRUN:-0}" = 1 ]; then printf '%s\n' "$body"; return 0; fi
  curl -fsS --max-time 20 -X POST ${FLEET_PULL_TOKEN:+-H "Authorization: Bearer $FLEET_PULL_TOKEN"} \
    -H "Content-Type: application/json" -d "$body" "$SERVER_URL/api/fleet/metrics/$FLEET_HOST" -o /dev/null
}
