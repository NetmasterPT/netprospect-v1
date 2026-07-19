#!/usr/bin/env bash
# deploy/reacher/blocklist-guard.sh — protege os IPs de validação do Reacher de ficarem em blacklists.
#
# Verifica cada IP em config/verify-proxies.json contra as DNSBLs principais (via DNS-over-HTTPS, porque
# o porto 53 está bloqueado no hel1-docker). Se ALGUM IP estiver LISTADO:
#   1) PAUSA o Reacher — move config/verify-proxies.json → .paused (reacher.enabled()=false → o verify cai
#      para as APIs free) e dispara o pull-agent (recria o worker verify sem Reacher).
#   2) ALERTA via ntfy (topic netprospect-alerts).
# NÃO re-ativa sozinho (após delisting, re-correr `deploy/reacher/activate.sh <domínio>` depois de rever).
#
# Corre de hora a hora (systemd --user timer no hel1-docker). Instalar:  ./blocklist-guard.sh install
# Verificar já:  ./blocklist-guard.sh   (ou `check`)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROXIES="$REPO/config/verify-proxies.json"
NTFY="http://100.118.244.35/netprospect-alerts"
BLS="zen.spamhaus.org b.barracudacentral.org bl.spamcop.net dnsbl.sorbs.net cbl.abuseat.org"
LOG="$REPO/deploy/reacher/blocklist-guard.log"
log(){ printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

install_timer(){
  local d="$HOME/.config/systemd/user"; mkdir -p "$d"
  cat > "$d/reacher-blocklist-guard.service" <<UNIT
[Unit]
Description=Reacher blocklist guard (pausa o Reacher se o IP de validação for listado)
[Service]
Type=oneshot
ExecStart=$REPO/deploy/reacher/blocklist-guard.sh check
UNIT
  cat > "$d/reacher-blocklist-guard.timer" <<UNIT
[Unit]
Description=Corre a guarda de blocklist do Reacher de hora a hora
[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now reacher-blocklist-guard.timer
  log "timer instalado + ativo (--user)"
  systemctl --user list-timers reacher-blocklist-guard.timer --no-pager 2>/dev/null | grep -i reacher
}

check(){
  [ -f "$PROXIES" ] || { log "sem verify-proxies.json (Reacher off) — nada a verificar"; exit 0; }
  local ips rev r listed=""
  ips=$(python3 -c 'import json,sys;print("\n".join(p.get("ip","") for p in json.load(open(sys.argv[1])) if p.get("ip")))' "$PROXIES" 2>/dev/null)
  [ -z "$ips" ] && { log "verify-proxies.json sem IPs"; exit 0; }
  for ip in $ips; do
    rev=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
    for bl in $BLS; do
      r=$(curl -s "https://dns.google/resolve?name=$rev.$bl&type=A" 2>/dev/null \
        | python3 -c 'import sys,json;a=json.load(sys.stdin).get("Answer",[]);print(a[0]["data"] if a else "")' 2>/dev/null)
      [ -n "$r" ] && listed="$listed $ip@$bl($r)"
    done
  done
  if [ -n "$listed" ]; then
    log "✗ LISTADO:$listed → a PAUSAR o Reacher"
    mv "$PROXIES" "$PROXIES.paused" 2>/dev/null && log "config/verify-proxies.json → .paused"
    curl -s -X POST "$NTFY" -H "Title: Reacher PAUSADO — IP de validação em blocklist" -H "Priority: high" \
      -H "Tags: warning,email" -d "Listado:$listed. verify-proxies.json → .paused; verify a usar só APIs. Rever + re-activar." >/dev/null 2>&1
    systemctl --user start netprospect-pull.service 2>/dev/null || true
    exit 2
  fi
  log "✓ IP(s) limpo(s): $(echo $ips | tr '\n' ' ')"
}

case "${1:-check}" in
  install) install_timer ;;
  check|"") check ;;
  *) echo "uso: $0 [check|install]"; exit 2 ;;
esac
