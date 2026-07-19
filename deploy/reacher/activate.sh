#!/usr/bin/env bash
# deploy/reacher/activate.sh <domínio-de-validação>
#
# LIGA o piloto do Reacher para um domínio já com FCrDNS configurado (ver docs/outreach-ops/dns-per-domain.md):
#   p1.<domínio>  A  49.12.120.250   +   PTR 49.12.120.250 -> p1.<domínio>
#
# Faz tudo num comando (idempotente, seguro re-correr):
#   1) GATE FCrDNS (aborta se o DNS/PTR ainda não bater — nada acontece antes disso)
#   2) gera/reusa a password do proxy (deploy/reacher/.proxy-pass, gitignored)
#   3) config/verify-proxies.json  (mount do worker verify no hel1-docker)
#   4) deploy/reacher/.env
#   5) de-minio: cria proxyuser + sincroniza + `docker compose up -d` (Dante + Reacher)
#   6) REACHER_URL/REACHER_FROM_EMAIL no store da frota + dispara o pull-agent (recria worker+worker-base)
#   7) smoke-tests (Reacher /v1 + dry-run do verify-core)
#
# Uso:   ./deploy/reacher/activate.sh np-mailcheck.pt
set -uo pipefail
D="${1:-}"; case "$D" in ""|--*) echo "uso: $0 <domínio-de-validação>"; exit 2;; esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELO="p1.$D"; FROM="verify@$D"
IP_DE="49.12.120.250"; DEMINIO_TS="100.124.43.117"; DEMINIO="root@$DEMINIO_TS"
SERVER_URL="http://100.114.17.74:3001"; FLEET_HOST="hel1-docker"
REACHER_URL="http://$DEMINIO_TS:8080"
PASSFILE="$REPO/deploy/reacher/.proxy-pass"
SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10"
say(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# 1) GATE FCrDNS -------------------------------------------------------------
say "1) FCrDNS gate  ($HELO <-> $IP_DE)"
fwd=$(dig +short "$HELO" 2>/dev/null | tail -1)
rev=$(dig +short -x "$IP_DE" 2>/dev/null | tail -1)
echo "   dig $HELO = ${fwd:-<vazio>}"
echo "   dig -x $IP_DE = ${rev:-<vazio>}"
if [ "$fwd" != "$IP_DE" ] || [ "$rev" != "$HELO." ]; then
  echo "   ✗ FCrDNS NÃO bate. Configura o DNS/PTR (docs/outreach-ops/dns-per-domain.md) e re-corre. Abortado."
  exit 1
fi
echo "   ✓ FCrDNS OK"

# 2) password do proxy (estável) --------------------------------------------
say "2) password do proxy"
if [ ! -f "$PASSFILE" ]; then openssl rand -hex 16 > "$PASSFILE"; chmod 600 "$PASSFILE"; echo "   gerada"; else echo "   reusada"; fi
PASS=$(cat "$PASSFILE")

# 3) config/verify-proxies.json (lido pelo worker verify no hel1-docker) -----
say "3) config/verify-proxies.json"
printf '[{ "id":"val1", "host":"127.0.0.1", "port":1080, "user":"proxyuser", "pass":"%s", "ip":"%s", "helo":"%s" }]\n' \
  "$PASS" "$IP_DE" "$HELO" > "$REPO/config/verify-proxies.json"
python3 -c "import json;json.load(open('$REPO/config/verify-proxies.json'));print('   ok (JSON válido)')"

# 4) deploy/reacher/.env -----------------------------------------------------
say "4) deploy/reacher/.env"
printf 'TAILNET_IP=%s\nREACHER_HELLO=%s\nREACHER_FROM=%s\n' "$DEMINIO_TS" "$HELO" "$FROM" > "$REPO/deploy/reacher/.env"
echo "   HELO=$HELO  FROM=$FROM"

# 5) de-minio: proxyuser + Dante + Reacher -----------------------------------
say "5) de-minio: proxyuser + Dante + Reacher"
$SSH "$DEMINIO" "id proxyuser >/dev/null 2>&1 || useradd --no-create-home --shell /usr/sbin/nologin proxyuser; echo 'proxyuser:$PASS' | chpasswd; mkdir -p /root/netprospect-v1/deploy/reacher"
scp -o StrictHostKeyChecking=no "$REPO/deploy/reacher/docker-compose.yml" "$REPO/deploy/reacher/danted.conf" "$REPO/deploy/reacher/.env" "$DEMINIO:/root/netprospect-v1/deploy/reacher/" >/dev/null
$SSH "$DEMINIO" "cd /root/netprospect-v1/deploy/reacher && docker compose up -d 2>&1 | tail -3"

# 6) REACHER_URL no store + recreate do worker verify ------------------------
say "6) REACHER_URL no store da frota + recreate do worker verify"
REACHER_URL="$REACHER_URL" FROM="$FROM" SERVER_URL="$SERVER_URL" FLEET_HOST="$FLEET_HOST" python3 - <<'PY'
import os, json, urllib.request
base=os.environ['SERVER_URL']; host=os.environ['FLEET_HOST']
adds={'REACHER_URL':os.environ['REACHER_URL'], 'REACHER_FROM_EMAIL':os.environ['FROM']}
with urllib.request.urlopen(f"{base}/api/fleet/env/{host}", timeout=10) as r: env=json.load(r).get('env','')
lines=[l for l in env.split('\n')]
for k,v in adds.items():
    lines=[l for l in lines if not l.startswith(k+'=')]; lines.append(f"{k}={v}")
newenv='\n'.join(lines).strip('\n')+'\n'
req=urllib.request.Request(f"{base}/api/fleet/env/{host}", data=json.dumps({'env':newenv}).encode(),
                           headers={'Content-Type':'application/json'}, method='PUT')
with urllib.request.urlopen(req, timeout=10) as r: print("   store PUT ok:", json.load(r).get('ok'))
PY
echo "   a disparar o pull-agent (recria worker+worker-base com REACHER_URL)..."
systemctl --user start netprospect-pull.service 2>/dev/null || echo "   (dispara manualmente o pull-agent se preciso)"

# 7) smoke-tests -------------------------------------------------------------
say "7) smoke-tests (aguarda ~20s pelo arranque do Reacher)"
sleep 20
echo -n "   Reacher /v1 (via tailnet): "
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -XPOST "$REACHER_URL/v1/check_email" \
  -H 'content-type: application/json' -d '{"to_email":"test@gmail.com"}' --max-time 30 2>/dev/null || echo "FALHA"
echo "   dry-run do verify-core (corporativo → Reacher, sem gravar):"
( cd "$REPO" && set -a; . docker/.env 2>/dev/null; set +a
  REACHER_URL="$REACHER_URL" REACHER_FROM_EMAIL="$FROM" node verify-emails.js --limit=10 --dry-run 2>&1 | tail -6 )

say "FEITO — piloto do Reacher ligado para $D"
echo "Próximo: node enqueue-email-verification.js --min-score=45   (enfileira os melhores leads)"
echo "Monitorizar: /api/queues (consumer verify) + /api/coverage (verify.verified a subir)."
