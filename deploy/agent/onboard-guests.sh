#!/usr/bin/env bash
# NetProspect — onboard em lote de guests LXC de um nó Proxmox (instala o reporter de métricas standalone
# DENTRO de cada CT). Corre NO nó pve (root). Salta guests sem as ferramentas ou sem alcance ao np-server.
# Requer /tmp/metrics-lib.sh + /tmp/metrics-report.sh no pve. Uso:
#   onboard-guests.sh <SERVER_URL> <DIRECTUS_PING_URL> <PG_HOST> "CTID:nome CTID:nome ..."
set -uo pipefail
SERVER_URL=$1; DIRECTUS_PING=$2; PGHOST=$3; PAIRS=$4
LIB=/tmp/metrics-lib.sh; REP=/tmp/metrics-report.sh
cat > /tmp/np.service <<'EOF'
[Unit]
Description=NetProspect metrics reporter
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/np/report.sh
EOF
cat > /tmp/np.timer <<'EOF'
[Unit]
Description=NetProspect metrics reporter (5min)
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true
[Install]
WantedBy=timers.target
EOF
for pair in $PAIRS; do
  ct=${pair%%:*}; name=${pair##*:}
  st=$(pct status "$ct" 2>/dev/null | awk '{print $2}')
  [ "$st" = "running" ] || { echo "[$name] SKIP — CT $ct não está running ($st)"; continue; }
  miss=$(pct exec "$ct" -- sh -c 'for c in curl python3 systemctl base64 nproc awk; do command -v $c >/dev/null 2>&1 || printf "%s " "$c"; done' 2>/dev/null)
  [ -n "$miss" ] && { echo "[$name] SKIP — faltam ferramentas: $miss"; continue; }
  reach=$(pct exec "$ct" -- curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$SERVER_URL/api/config" 2>/dev/null)
  [ "$reach" = "200" ] || { echo "[$name] SKIP — sem alcance ao np-server (http=$reach)"; continue; }
  pct exec "$ct" -- mkdir -p /opt/np
  pct push "$ct" "$LIB" /opt/np/metrics-lib.sh
  pct push "$ct" "$REP" /opt/np/report.sh
  pct exec "$ct" -- chmod +x /opt/np/metrics-lib.sh /opt/np/report.sh
  printf 'FLEET_HOST=%s\nSERVER_URL=%s\nFLEET_PULL_TOKEN=\nDIRECTUS_PING_URL=%s\nPG_HOST=%s\nPG_PORT=5432\n' \
    "$name" "$SERVER_URL" "$DIRECTUS_PING" "$PGHOST" > /tmp/np.env
  pct push "$ct" /tmp/np.env /etc/netprospect-metrics.env
  pct exec "$ct" -- chmod 600 /etc/netprospect-metrics.env
  pct push "$ct" /tmp/np.service /etc/systemd/system/netprospect-metrics.service
  pct push "$ct" /tmp/np.timer /etc/systemd/system/netprospect-metrics.timer
  pct exec "$ct" -- systemctl daemon-reload
  if pct exec "$ct" -- /opt/np/report.sh >/dev/null 2>&1; then
    pct exec "$ct" -- systemctl enable --now netprospect-metrics.timer >/dev/null 2>&1
    echo "[$name] OK (CT $ct)"
  else echo "[$name] FALHOU o run de teste (CT $ct)"; fi
done
