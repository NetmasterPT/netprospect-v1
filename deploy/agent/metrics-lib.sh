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
    | grep -vE '^(systemd-|user@|user-runtime|session-|dbus|polkit|getty@|serial-getty@|container-getty@|console-|emergency|rescue|dracut|kmod|ldconfig|apt-daily|man-db|e2scrub|fstrim|logrotate|motd|snapd\.seeded|networkd-dispatcher|multipathd|unattended|packagekit|accounts-daemon|rtkit|udisks| modprobe|cloud-|qemu-guest)' | head -25
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

# Timers systemd (≈ crons) → pseudo-unidades (kind=timer). Estado + próxima execução + descrição.
timers_json() {
  command -v systemctl >/dev/null 2>&1 || { printf '[]'; return; }
  local first=1 unit svc active desc nextus nexts lastus lasts k v logb64
  printf '['
  while read -r unit; do
    [ -z "$unit" ] && continue
    active=""; desc=""; nextus=""; lastus=""
    while IFS='=' read -r k v; do case "$k" in ActiveState) active=$v ;; Description) desc=$v ;; NextElapseUSecRealtime) nextus=$v ;; LastTriggerUSec) lastus=$v ;; esac; done < <(systemctl show "$unit" -p ActiveState -p Description -p NextElapseUSecRealtime -p LastTriggerUSec 2>/dev/null)
    nexts=""; case "$nextus" in ''|*[!0-9]*) ;; *) nexts=$(date -d "@$((nextus / 1000000))" '+%d/%m %H:%M' 2>/dev/null) ;; esac
    lasts=""; case "$lastus" in ''|0|*[!0-9]*) ;; *) lasts=$(date -d "@$((lastus / 1000000))" '+%d/%m %H:%M' 2>/dev/null) ;; esac
    # Log = journalctl do serviço que o timer dispara (mostra as últimas execuções + resultado).
    svc="${unit%.timer}.service"
    logb64=$(journalctl -u "$svc" -n 12 --no-pager -o cat 2>/dev/null | tail -c 3000 | base64 -w0 2>/dev/null)
    [ "$first" = 1 ] && first=0 || printf ','
    printf '{"kind":"timer","id":"timer:%s","name":"%s","state":"%s","status":"%s","image":"%s","cpu":"","memb":"","logb64":"%s"}' \
      "$(esc_json "$unit")" "$(esc_json "${unit%.timer}")" "$(esc_json "$active")" "$(esc_json "${nexts:+próx. $nexts · }${lasts:+últ. $lasts · }$desc")" "$(esc_json "$desc")" "$logb64"
  done < <(systemctl list-units --type=timer --all --no-legend --plain 2>/dev/null | awk '{print $1}' | head -25)
  printf ']'
}

# Matriz de latência: pede ao dashboard a lista de nós (/api/fleet/targets) e faz ping (ICMP) a cada um em
# paralelo (python). Devolve um mapa JSON {host: ms}. Vazio se sem python/targets. Exclui-se a si próprio.
latency_matrix() {
  command -v python3 >/dev/null 2>&1 || { printf '{}'; return; }
  curl -fsS --max-time 8 "${SERVER_URL}/api/fleet/targets" 2>/dev/null | FLEET_HOST="${FLEET_HOST:-}" python3 -c '
import sys, json, subprocess, re, os
from concurrent.futures import ThreadPoolExecutor
try: targets = json.load(sys.stdin)
except Exception: print("{}"); sys.exit()
me = os.environ.get("FLEET_HOST", "")
def ping(t):
    addr = t.get("addr"); host = t.get("host")
    if not addr or not host or host == me: return None
    try:
        r = subprocess.run(["ping", "-c", "1", "-W", "1", addr], capture_output=True, text=True, timeout=3)
        m = re.search(r"time=([\d.]+)", r.stdout)
        return (host, round(float(m.group(1)))) if m else None
    except Exception: return None
out = {}
with ThreadPoolExecutor(max_workers=24) as ex:
    for res in ex.map(ping, targets[:80]):
        if res: out[res[0]] = res[1]
print(json.dumps(out))
' 2>/dev/null || printf '{}'
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
  local memt mema mem_total mem_used swapt swapf swap_total swap_used disk_total disk_used load cores uptime
  memt=$(awk '/^MemTotal:/{print $2}' /proc/meminfo); mema=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  mem_total=$((memt / 1024)); mem_used=$(((memt - mema) / 1024))
  swapt=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo); swapf=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
  swap_total=$(((swapt + 0) / 1024)); swap_used=$((((swapt + 0) - (swapf + 0)) / 1024))
  read -r disk_total disk_used < <(df -P -k / | awk 'NR==2{printf "%.0f %.0f", $2/1048576, $3/1048576}')
  load=$(awk '{print $1}' /proc/loadavg); cores=$(nproc 2>/dev/null || echo 0); uptime=$(awk '{printf "%d", $1}' /proc/uptime)
  local lat_directus lat_pg lat_minio units np_ip addr latmatrix
  lat_directus=$(http_ms "${DIRECTUS_PING_URL:-}"); lat_minio=$(http_ms "${MINIO_HEALTH_URL:-}"); lat_pg=$(tcp_ms "${PG_HOST:-}" "${PG_PORT:-5432}")
  # IP deste host (o src usado para chegar ao np-server) → alvo pingável para a matriz de latência.
  np_ip=$(printf '%s' "${SERVER_URL:-}" | sed -E 's#^https?://([^:/]+).*#\1#')
  addr=$(ip route get "$np_ip" 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1)
  latmatrix=$(latency_matrix); [ -z "$latmatrix" ] && latmatrix='{}'
  # Tailnet a que este host pertence (MagicDNSSuffix), p/ os badges Tailnet/Tailnet-TFAA. Vazio se sem tailscale.
  local tailnet=""; command -v tailscale >/dev/null 2>&1 && tailnet=$(tailscale status --json 2>/dev/null | grep -oE '"MagicDNSSuffix"[^,]*' | grep -oE '[a-z0-9]+\.ts\.net' | head -1)
  units=$(merge_json_arrays "$(containers_json)" "$(services_json)")
  units=$(merge_json_arrays "$units" "$(timers_json)")
  # Hook opcional: se o reporter definir extra_units_json (ex.: Proxmox → LXC/VMs), junta-se aqui.
  if declare -F extra_units_json >/dev/null 2>&1; then units=$(merge_json_arrays "$units" "$(extra_units_json)"); fi
  local body
  body=$(printf '{"cpu":%s,"load":%s,"cores":%s,"mem_used":%s,"mem_total":%s,"swap_used":%s,"swap_total":%s,"disk_used":%s,"disk_total":%s,"io_read":%s,"io_write":%s,"net_rx":%s,"net_tx":%s,"uptime":%s,"addr":"%s","latmatrix":%s,"containers":%s%s%s%s}' \
    "$cpu" "${load:-0}" "${cores:-0}" "$mem_used" "$mem_total" "${swap_used:-0}" "${swap_total:-0}" "$disk_used" "$disk_total" "$io_read" "$io_write" "$net_rx" "$net_tx" "$uptime" "${addr:-}" "$latmatrix" "$units" \
    "${lat_directus:+,\"lat_directus\":$lat_directus}" "${lat_pg:+,\"lat_pg\":$lat_pg}" "${lat_minio:+,\"lat_minio\":$lat_minio}")
  if [ "${METRICS_DRYRUN:-0}" = 1 ]; then printf '%s\n' "$body"; return 0; fi
  # Body por STDIN (--data-binary @-), NÃO como argumento: com os nós PVE a trazerem centenas de unidades +
  # logs, o body passa dos 128 KB (MAX_ARG_STRLEN do Linux) e `-d "$body"` dá "Argument list too long".
  printf '%s' "$body" | curl -fsS --max-time 25 -X POST ${FLEET_PULL_TOKEN:+-H "Authorization: Bearer $FLEET_PULL_TOKEN"} \
    -H "Content-Type: application/json" --data-binary @- "$SERVER_URL/api/fleet/metrics/$FLEET_HOST" -o /dev/null
}
