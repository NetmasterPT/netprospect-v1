#!/usr/bin/env bash
# NetProspect — coletor Proxmox (LXC + VMs) do nó local, em JSON, no schema das "unidades" do dashboard.
# Corre como ROOT (pvesh/pct/qm exigem root) → o reporter não-root chama-o via `sudo -n`. SÓ LÊ.
# Saída: array JSON com {kind:lxc|vm, id, name, state, status, image, cpu, memb, logb64}.
set -uo pipefail
command -v pvesh >/dev/null 2>&1 || { printf '[]'; exit 0; }
node="$(hostname)"
# Programa python passado por -c (NÃO por heredoc no stdin — o stdin é para os dados do pipe).
PYPROG='
import sys, json
node = sys.argv[1]
raw = sys.stdin.read().split(chr(0x1e))
out = []
def add(txt, kind):
    try: data = json.loads(txt or "[]")
    except Exception: return
    for r in data:
        vmid = r.get("vmid", "")
        status = r.get("status", "") or ""
        name = r.get("name") or str(vmid)
        cpu = r.get("cpu"); mem = r.get("mem"); up = r.get("uptime")
        cpu_s = "%.1f%%" % (cpu * 100) if isinstance(cpu, (int, float)) and status == "running" else ""
        st = status
        if isinstance(up, int) and up > 0:
            st = "%s . up %dd" % (status, up // 86400) if up >= 86400 else "%s . up %dh" % (status, up // 3600)
        out.append({"kind": kind, "id": "%s:%s" % (kind, vmid), "name": name, "state": status,
                    "status": st, "image": "vmid %s . %s" % (vmid, node),
                    "cpu": cpu_s, "memb": str(int(mem)) if isinstance(mem, (int, float)) else "", "logb64": ""})
add(raw[0] if len(raw) > 0 else "[]", "lxc")
add(raw[1] if len(raw) > 1 else "[]", "vm")
print(json.dumps(out))
'
{ pvesh get "/nodes/$node/lxc" --output-format json 2>/dev/null; printf '\036'; pvesh get "/nodes/$node/qemu" --output-format json 2>/dev/null; } | python3 -c "$PYPROG" "$node"
