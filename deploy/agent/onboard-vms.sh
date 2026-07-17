#!/usr/bin/env bash
# NetProspect — onboard de guests VM de um nó Proxmox via o qemu-guest-agent (qm guest exec). Instala o
# reporter dentro da VM (ficheiros por base64, sem SSH — a ACL do Tailscale bloqueia SSH aos guests).
# Corre NO nó pve (root). Requer /tmp/metrics-lib.sh + /tmp/metrics-report.sh. Uso:
#   onboard-vms.sh <SERVER_URL> <DIRECTUS_PING_URL> <PG_HOST> "VMID:nome VMID:nome ..."
set -uo pipefail
SERVER_URL=$1; DIRECTUS_PING=$2; PGHOST=$3; PAIRS=$4
LIB_B64=$(base64 -w0 /tmp/metrics-lib.sh)
REP_B64=$(base64 -w0 /tmp/metrics-report.sh)
qok() { qm guest exec "$1" -- bash -c "$2" 2>/dev/null | grep -q '"exitcode" : 0'; }
for pair in $PAIRS; do
  id=${pair%%:*}; name=${pair##*:}
  qm guest exec "$id" -- true >/dev/null 2>&1 || { echo "[$name] SKIP — sem guest-agent (VM $id)"; continue; }
  reach=$(qm guest exec "$id" -- curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$SERVER_URL/api/config" 2>/dev/null | grep -oE '"out-data" : "[0-9]+"' | grep -oE '[0-9]+')
  [ "$reach" = "200" ] || { echo "[$name] SKIP — sem alcance ao np-server (http=$reach) (VM $id)"; continue; }
  qok "$id" "mkdir -p /opt/np && echo '$LIB_B64' | base64 -d > /opt/np/metrics-lib.sh && chmod +x /opt/np/metrics-lib.sh" || { echo "[$name] FALHOU push lib"; continue; }
  qok "$id" "echo '$REP_B64' | base64 -d > /opt/np/report.sh && chmod +x /opt/np/report.sh" || { echo "[$name] FALHOU push report"; continue; }
  qok "$id" "printf 'FLEET_HOST=%s\nSERVER_URL=%s\nFLEET_PULL_TOKEN=\nDIRECTUS_PING_URL=%s\nPG_HOST=%s\nPG_PORT=5432\n' '$name' '$SERVER_URL' '$DIRECTUS_PING' '$PGHOST' > /etc/netprospect-metrics.env && chmod 600 /etc/netprospect-metrics.env"
  qok "$id" "printf '[Unit]\nDescription=NetProspect metrics reporter\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/opt/np/report.sh\n' > /etc/systemd/system/netprospect-metrics.service"
  qok "$id" "printf '[Unit]\nDescription=NetProspect metrics reporter (5min)\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/netprospect-metrics.timer && systemctl daemon-reload"
  if qok "$id" "/opt/np/report.sh"; then
    qok "$id" "systemctl enable --now netprospect-metrics.timer"
    echo "[$name] OK (VM $id)"
  else echo "[$name] FALHOU o run de teste (VM $id)"; fi
done
