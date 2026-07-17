#!/usr/bin/env bash
# NetProspect — coletor Proxmox do nó local, em JSON, no schema das "unidades" do dashboard.
# Corre como ROOT (pvesh/pct/qm/zpool exigem root); o oneshot np-pve-units.service escreve a saída em
# /run/np-pve-units.json (world-readable) e o reporter não-root consome-a. SÓ LÊ.
# Emite: LXC + VMs (kind=lxc|vm, com nº de snapshots no status), storages (kind=storage), pools ZFS
# (kind=zfs, com health). Campos: {kind,id,name,state,status,image,cpu,memb,logb64}.
set -uo pipefail
command -v pvesh >/dev/null 2>&1 || { printf '[]'; exit 0; }
node="$(hostname)"

LXC="$(pvesh get "/nodes/$node/lxc" --output-format json 2>/dev/null || echo '[]')"
QEMU="$(pvesh get "/nodes/$node/qemu" --output-format json 2>/dev/null || echo '[]')"
STOR="$(pvesh get "/nodes/$node/storage" --output-format json 2>/dev/null || echo '[]')"

# Contagem de snapshots por guest (exclui a pseudo-snapshot "current"). Mapa JSON "type:vmid" -> n.
guest_ids() { python3 -c "import sys,json;[print('%s:%s'%(sys.argv[1],r['vmid'])) for r in json.load(sys.stdin)]" "$1" 2>/dev/null; }
SNAPS='{'; sf=1
for vt in $(printf '%s' "$LXC" | guest_ids lxc) $(printf '%s' "$QEMU" | guest_ids qemu); do
  typ="${vt%%:*}"; vmid="${vt##*:}"
  n=$(pvesh get "/nodes/$node/$typ/$vmid/snapshot" --output-format json 2>/dev/null | python3 -c "import sys,json;print(sum(1 for s in json.load(sys.stdin) if s.get('name')!='current'))" 2>/dev/null || echo 0)
  [ "$sf" = 1 ] && sf=0 || SNAPS="$SNAPS,"; SNAPS="$SNAPS\"$vt\":$n"
done
SNAPS="$SNAPS}"

# Pools ZFS (health + uso) — o storage API não dá health.
ZFS='[]'; if command -v zpool >/dev/null 2>&1; then
  ZFS=$(zpool list -Hp -o name,health,size,alloc 2>/dev/null | python3 -c "
import sys, json
out=[]
for line in sys.stdin:
    p=line.rstrip('\n').split('\t')
    if len(p)<4: continue
    name,health,size,alloc=p[0],p[1],p[2],p[3]
    try: pct=round(100*int(alloc)/int(size)) if int(size)>0 else 0
    except: pct=0
    out.append({'name':name,'health':health,'size':int(size),'alloc':int(alloc),'pct':pct})
print(json.dumps(out))
" 2>/dev/null || echo '[]')
fi

PYPROG='
import sys, json
node = sys.argv[1]
raw = sys.stdin.read().split(chr(0x1e))
snaps = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
out = []
def human(n):
    n=float(n)
    for u in ["B","KB","MB","GB","TB","PB"]:
        if n<1024: return ("%.1f%s"%(n,u)) if u not in ("B","KB") else ("%d%s"%(n,u))
        n/=1024
    return "%.1fEB"%n
def add_guest(txt, kind):
    try: data=json.loads(txt or "[]")
    except Exception: return
    for r in data:
        vmid=r.get("vmid",""); status=r.get("status","") or ""; name=r.get("name") or str(vmid)
        cpu=r.get("cpu"); mem=r.get("mem"); up=r.get("uptime")
        cpu_s="%.1f%%"%(cpu*100) if isinstance(cpu,(int,float)) and status=="running" else ""
        st=status
        if isinstance(up,int) and up>0: st += " . up %dd"%(up//86400) if up>=86400 else " . up %dh"%(up//3600)
        ns=snaps.get("%s:%s"%(kind,vmid),0)
        if ns: st += " . %d snap%s"%(ns, "s" if ns!=1 else "")
        out.append({"kind":kind,"id":"%s:%s"%(kind,vmid),"name":name,"state":status,"status":st,
                    "image":"vmid %s . %s"%(vmid,node),"cpu":cpu_s,
                    "memb":str(int(mem)) if isinstance(mem,(int,float)) else "","logb64":""})
def add_storage(txt):
    try: data=json.loads(txt or "[]")
    except Exception: return
    for s in data:
        used=s.get("used"); total=s.get("total"); typ=s.get("type","")
        active = "active" if s.get("active") else ("enabled" if s.get("enabled") else "inactive")
        pct = round(100*used/total) if isinstance(used,(int,float)) and isinstance(total,(int,float)) and total else None
        st = "%s"%typ
        if pct is not None: st = "%s . %s/%s (%d%%)"%(typ, human(used), human(total), pct)
        out.append({"kind":"storage","id":"stor:%s"%s.get("storage",""),"name":s.get("storage",""),
                    "state":active,"status":st,"image":"storage %s . %s"%(typ,node),
                    "cpu":"","memb":str(int(used)) if isinstance(used,(int,float)) else "","logb64":""})
def add_zfs(txt):
    try: data=json.loads(txt or "[]")
    except Exception: return
    for z in data:
        out.append({"kind":"zfs","id":"zfs:%s"%z.get("name",""),"name":z.get("name",""),
                    "state":z.get("health",""),"status":"%s . %s/%s (%d%%)"%(z.get("health",""),human(z.get("alloc",0)),human(z.get("size",0)),z.get("pct",0)),
                    "image":"pool ZFS . %s"%node,"cpu":"","memb":str(int(z.get("alloc",0))),"logb64":""})
add_guest(raw[0] if len(raw)>0 else "[]","lxc")
add_guest(raw[1] if len(raw)>1 else "[]","vm")
add_storage(raw[2] if len(raw)>2 else "[]")
add_zfs(raw[3] if len(raw)>3 else "[]")
print(json.dumps(out))
'
{ printf '%s\036%s\036%s\036%s' "$LXC" "$QEMU" "$STOR" "$ZFS"; } | python3 -c "$PYPROG" "$node" "$SNAPS"
