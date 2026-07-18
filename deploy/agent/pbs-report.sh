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
  local ds_arr='[' bk_arr='[]' first=1 name path comment line du dt pct hstat part
  while IFS='|' read -r name path comment; do
    [ -z "$name" ] && continue
    line=$(df -Pk "$path" 2>/dev/null | awk 'NR==2{u=$3*1024;t=$2*1024;p=(t>0)?int(100*u/t):0; printf "%d|%d|%d", u, t, p}')
    IFS='|' read -r du dt pct <<< "${line:-0|0|0}"
    hstat=$(awk -v u="${du:-0}" -v t="${dt:-0}" -v p="${pct:-0}" 'BEGIN{split("B KB MB GB TB PB",U," ");a=u;i=1;while(a>=1024&&i<6){a/=1024;i++};b=t;j=1;while(b>=1024&&j<6){b/=1024;j++};printf "%.1f%s/%.1f%s (%d%%)",a,U[i],b,U[j],p}')
    [ "$first" = 1 ] && first=0 || ds_arr="$ds_arr,"
    ds_arr="$ds_arr$(printf '{"kind":"datastore","id":"ds:%s","name":"%s","state":"active","status":"%s","image":"%s","cpu":"","memb":"%s","memtotal":"%s","storage":"%s","logb64":""}' \
      "$(esc_json "$name")" "$(esc_json "$name")" "$(esc_json "$hstat${comment:+ · }$comment")" "$(esc_json "$path")" "${du:-0}" "${dt:-0}" "$(esc_json "$name")")"
    # Snapshots do datastore → unidades kind=backup (mais recentes 1º, cap 40) — mostradas no drawer do
    # datastore e agregadas na secção Backups. `storage` = nome do datastore.
    # PBS não tem `snapshot list` no manager (é do client, com auth). Enumera o filesystem do datastore:
    # <ds>/{ct,vm,host}/<id>/<timestamp>/ = uma snapshot. Só ct/vm/host → evita o enorme .chunks.
    part=$( { for t in ct vm host; do find "$path/$t" -mindepth 2 -maxdepth 2 -type d 2>/dev/null || true; done; } | DS="$name" DSPATH="$path" python3 -c '
import sys,os,json
ds=os.environ.get("DS",""); dsp=os.environ.get("DSPATH","")
def human(n):
    n=float(n or 0)
    for u in ["B","KB","MB","GB","TB","PB"]:
        if n<1024: return ("%.1f%s"%(n,u)) if u not in ("B","KB") else ("%d%s"%(n,u))
        n/=1024
    return "%.1fEB"%n
snaps=[]
for ln in sys.stdin:
    p=ln.strip();
    if not p: continue
    parts=os.path.relpath(p, dsp).split("/")
    if len(parts)<3: continue
    snaps.append((parts[2], parts[0], parts[1], p))   # (timestamp, type, id, path)
snaps.sort(reverse=True); snaps=snaps[:40]
out=[]
for ts,bt,bid,p in snaps:
    try: sz=sum(os.path.getsize(os.path.join(p,f)) for f in os.listdir(p) if os.path.isfile(os.path.join(p,f)))
    except Exception: sz=0
    when=(ts.replace("T"," ")[:16]) if "T" in ts else ts
    out.append({"kind":"backup","id":"bk:%s:%s:%s:%s"%(ds,bt,bid,ts),"name":"%s/%s @%s"%(bt,bid,when),"state":"backup","status":"%s . %s . %s"%(ds,when,human(sz)),"image":"pbs %s"%ds,"cpu":"","memb":str(sz),"vmid":bid,"storage":ds,"logb64":""})
print(json.dumps(out))
' 2>/dev/null )
    [ -z "$part" ] && part='[]'
    bk_arr=$(merge_json_arrays "$bk_arr" "$part")
  done <<< "$pairs"
  ds_arr="$ds_arr]"
  merge_json_arrays "$ds_arr" "$bk_arr"
}

if collect_and_post; then echo "métricas enviadas ($FLEET_HOST)"; else echo "envio de métricas falhou" >&2; exit 1; fi
