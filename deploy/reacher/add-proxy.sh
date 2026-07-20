#!/usr/bin/env bash
# deploy/reacher/add-proxy.sh — adiciona um 2.º/3.º IP de egress ao pool do Reacher.
#
# O Reacher (ÚNICO, no de-minio) passa a fazer round-robin também por este IP — `lib/reacher.js` já suporta
# a LISTA de proxies (verify-proxies.json), por isso NÃO é preciso código novo. Este host corre SÓ um Dante,
# ligado à TAILNET (o co-locado do de-minio escuta em 127.0.0.1; este tem de ser alcançável pelo Reacher
# remoto), RESTRITO ao IP tailnet do Reacher (proxy fechado, não aberto).
#
# Pré-req: pN.<domínio> com FCrDNS p/ o novo IP (A + PTR) + porta 25 aberta + IP Spamhaus-limpo
#   (docs/outreach-ops/00-port25-and-ips.md · dns-per-domain.md). O host já na tailnet + com Docker.
#
# Uso: ./add-proxy.sh <domínio> <IP-limpo> <tailnet-IP-do-host> <ssh-do-host> [prefixo-helo=p2]
#   ex: ./add-proxy.sh np-mailcheck.pt 65.108.120.25 100.99.1.2 root@100.99.1.2 p2
#
# ⚠️ NÃO-TESTADO ainda (precisa de um 2.º IP real p/ validar). Idempotente: re-correr é seguro.
set -uo pipefail
D="${1:?uso: ./add-proxy.sh <domínio> <IP-limpo> <tailnet-IP-host> <ssh-host> [helo=p2]}"
IP="${2:?falta o IP-limpo}"; HOST_TS="${3:?falta o tailnet-IP do host}"; HOST_SSH="${4:?falta o ssh do host (user@host)}"
HELO="${5:-p2}.$D"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REACHER_TS="100.124.43.117"          # IP tailnet do de-minio (Reacher único) — só ELE pode usar este Dante
SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10"
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# 1) GATE FCrDNS (pN.<D> <-> IP) via DoH (o dig/porta-53 está bloqueado no hel1-docker) -----------
say "1) FCrDNS gate ($HELO <-> $IP)"
doh_a(){ curl -s "https://dns.google/resolve?name=$1&type=A" 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((a["data"] for a in d.get("Answer",[]) if a.get("type")==1),""))' 2>/dev/null; }
doh_ptr(){ local r; r=$(echo "$1"|awk -F. '{print $4"."$3"."$2"."$1}'); curl -s "https://dns.google/resolve?name=$r.in-addr.arpa&type=PTR" 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next((a["data"] for a in d.get("Answer",[]) if a.get("type")==12),""))' 2>/dev/null; }
fwd=$(doh_a "$HELO"); rev=$(doh_ptr "$IP")
echo "   $HELO A=${fwd:-<vazio>} ; PTR $IP=${rev:-<vazio>}"
{ [ "$fwd" = "$IP" ] && [ "$rev" = "$HELO." ]; } || { echo "   ✗ FCrDNS NÃO bate — configura DNS/PTR (dns-per-domain.md) e re-corre. Abortado."; exit 1; }
echo "   ✓ FCrDNS OK"

# 2) Dante tailnet-bound no host novo (restrito ao IP do Reacher) --------------------------------
say "2) Dante (tailnet-bound) em $HOST_SSH"
IFACE=$($SSH "$HOST_SSH" "ip route show default | awk '{print \$5; exit}'" 2>/dev/null)
[ -n "$IFACE" ] || { echo "   ✗ não obtive a interface de default-route no host (ssh ok?). Abortado."; exit 1; }
echo "   iface de egress: $IFACE  → IP público $IP"
TMP=$(mktemp -d)
cat > "$TMP/danted.conf" <<EOF
# Dante SOCKS5 — egress do IP $IP p/ o Reacher remoto ($REACHER_TS). Escuta na tailnet ($HOST_TS:1080),
# restrito ao IP tailnet do Reacher (proxy FECHADO). Egressa por $IFACE. Gerado por add-proxy.sh.
logoutput: stderr
internal: $HOST_TS port = 1080
external: $IFACE
socksmethod: none
user.privileged: root
user.unprivileged: nobody
client pass { from: $REACHER_TS/32 to: 0.0.0.0/0
  log: error }
socks pass { from: $REACHER_TS/32 to: 0.0.0.0/0
  protocol: tcp command: connect log: error }
EOF
cat > "$TMP/docker-compose.yml" <<'EOF'
# Dante-only (egress dum IP limpo p/ o Reacher remoto). Gerado por deploy/reacher/add-proxy.sh.
services:
  dante:
    image: wernight/dante
    restart: unless-stopped
    network_mode: host
    volumes: [ "./danted.conf:/etc/danted.conf:ro" ]
EOF
$SSH "$HOST_SSH" "mkdir -p /root/reacher-proxy"
scp -o StrictHostKeyChecking=no "$TMP/danted.conf" "$TMP/docker-compose.yml" "$HOST_SSH:/root/reacher-proxy/" >/dev/null
$SSH "$HOST_SSH" "cd /root/reacher-proxy && docker compose up -d 2>&1 | tail -2"
rm -rf "$TMP"

# 3) APPEND a config/verify-proxies.json (NÃO sobrepõe) -----------------------------------------
say "3) config/verify-proxies.json (append)"
IP="$IP" HOST_TS="$HOST_TS" HELO="$HELO" PROXIES="$REPO/config/verify-proxies.json" python3 - <<'PY'
import os, json
p=os.environ['PROXIES']
arr=json.load(open(p)) if os.path.exists(p) else []
if any(x.get('ip')==os.environ['IP'] for x in arr):
    print("   já existe uma entrada com este IP — nada a acrescentar"); raise SystemExit
ids={x.get('id') for x in arr}; n=2
while f"val{n}" in ids: n+=1
entry={"id":f"val{n}","host":os.environ['HOST_TS'],"port":1080,"ip":os.environ['IP'],"helo":os.environ['HELO']}
arr.append(entry); json.dump(arr, open(p,'w'), indent=2)
print("   +", json.dumps(entry), f"  (total {len(arr)} proxies)")
PY

# 4) recreate do worker verify (puxa a lista nova) ----------------------------------------------
say "4) recreate do worker verify"
echo "   O config/verify-proxies.json é montado no worker verify (hel1-docker). Recria p/ carregar a lista:"
echo "     docker compose -f docker/docker-compose.yml up -d --force-recreate <worker-verify>   (ou o pull-agent)"
systemctl --user start netprospect-pull.service 2>/dev/null || echo "   (dispara o pull-agent manualmente se aplicável)"

say "FEITO — IP $IP (via $HELO) adicionado ao pool do Reacher"
echo "O Reacher único passa a alternar 127.0.0.1:1080 (de-minio) ↔ $HOST_TS:1080 ($IP) — round-robin + cooldowns por IP (lib/reacher.js)."
echo "Smoke: manda alguns verifies e confirma nos logs do Reacher que ambos os IPs egressam."
