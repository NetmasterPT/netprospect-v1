#!/usr/bin/env bash
# install-alloy-native.sh — Alloy nativo (journald→Loki) para hosts SEM Docker (nós Proxmox + CTs).
# Corre-se no host/CT (root). Config: /etc/alloy/config-journald.alloy (vem por scp/pct push).
#   bash install-alloy-native.sh <HOSTNAME_LABEL>
set -euo pipefail
HOSTLABEL="${1:?falta o HOSTNAME_LABEL (arg 1)}"
VER=1.5.1
if [ ! -x /usr/local/bin/alloy ]; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq unzip curl ca-certificates >/dev/null 2>&1
  curl -fsSL -o /tmp/alloy.zip "https://github.com/grafana/alloy/releases/download/v${VER}/alloy-linux-amd64.zip"
  unzip -o /tmp/alloy.zip -d /tmp >/dev/null
  install -m0755 /tmp/alloy-linux-amd64 /usr/local/bin/alloy
  rm -f /tmp/alloy.zip /tmp/alloy-linux-amd64
fi
mkdir -p /etc/alloy /var/lib/alloy
cat > /etc/systemd/system/alloy.service <<EOF
[Unit]
Description=Grafana Alloy (journald -> Loki)
After=network-online.target
Wants=network-online.target
[Service]
Environment=HOSTNAME_LABEL=${HOSTLABEL}
ExecStart=/usr/local/bin/alloy run /etc/alloy/config-journald.alloy --storage.path=/var/lib/alloy --server.http.listen-addr=127.0.0.1:12346
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now alloy >/dev/null 2>&1
sleep 3
echo "alloy: $(systemctl is-active alloy) (host=${HOSTLABEL})"
