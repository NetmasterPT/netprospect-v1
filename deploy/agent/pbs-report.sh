#!/usr/bin/env bash
# NetProspect — reporter para Proxmox Backup Server (PBS). Corre DENTRO do LXC do PBS (como root — é um
# appliance sem sudo; proxmox-backup-manager exige root). Reusa metrics-lib.sh (host /proc + serviços
# systemd, ex.: proxmox-backup, proxmox-backup-proxy) e acrescenta os DATASTORES (kind=datastore, uso via
# df do path). POST /api/fleet/metrics/<FLEET_HOST>. systemd timer 5 min.
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${METRICS_ENV:-/etc/netprospect-metrics.env}"
# shellcheck disable=SC1090
[ -f "$CFG" ] && { set -a; . "$CFG"; set +a; }
: "${FLEET_HOST:?FLEET_HOST em falta}" ; : "${SERVER_URL:?SERVER_URL em falta}"
[ -f "$SELF/metrics-lib.sh" ] || { echo "falta $SELF/metrics-lib.sh"; exit 1; }
# shellcheck source=metrics-lib.sh
. "$SELF/metrics-lib.sh"

extra_units_json() {
  command -v proxmox-backup-manager >/dev/null 2>&1 || { printf '[]'; return; }
  local dsjson pairs; dsjson=$(proxmox-backup-manager datastore list --output-format json 2>/dev/null || echo '[]')
  pairs=$(printf '%s' "$dsjson" | python3 -c "import sys,json;[print((d.get('name') or '')+'|'+(d.get('path') or '')+'|'+(d.get('comment') or '')) for d in json.load(sys.stdin)]" 2>/dev/null || true)
  local first=1 name path comment line du dt pct hstat
  printf '['
  while IFS='|' read -r name path comment; do
    [ -z "$name" ] && continue
    line=$(df -Pk "$path" 2>/dev/null | awk 'NR==2{u=$3*1024;t=$2*1024;p=(t>0)?int(100*u/t):0; printf "%d|%d|%d", u, t, p}')
    IFS='|' read -r du dt pct <<< "${line:-0|0|0}"
    hstat=$(awk -v u="${du:-0}" -v t="${dt:-0}" -v p="${pct:-0}" 'BEGIN{split("B KB MB GB TB PB",U," ");a=u;i=1;while(a>=1024&&i<6){a/=1024;i++};b=t;j=1;while(b>=1024&&j<6){b/=1024;j++};printf "%.1f%s/%.1f%s (%d%%)",a,U[i],b,U[j],p}')
    [ "$first" = 1 ] && first=0 || printf ','
    printf '{"kind":"datastore","id":"ds:%s","name":"%s","state":"active","status":"%s","image":"%s","cpu":"","memb":"%s","logb64":""}' \
      "$(esc_json "$name")" "$(esc_json "$name")" "$(esc_json "$hstat${comment:+ · }$comment")" "$(esc_json "$path")" "${du:-0}"
  done <<< "$pairs"
  printf ']'
}

if collect_and_post; then echo "métricas enviadas ($FLEET_HOST)"; else echo "envio de métricas falhou" >&2; exit 1; fi
