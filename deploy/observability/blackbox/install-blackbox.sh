#!/usr/bin/env bash
# install-blackbox.sh — corre-se DENTRO do CT de1-blackbox (via pct exec). blackbox_exporter + systemd.
# Config vem por pct push para /opt/blackbox-exporter/blackbox.yml.
set -euo pipefail
VER=0.25.0
mkdir -p /opt/blackbox-exporter
if [ ! -x /opt/blackbox-exporter/blackbox_exporter ] || ! /opt/blackbox-exporter/blackbox_exporter --version 2>&1 | grep -q "$VER"; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
  curl -fsSL -o /tmp/bb.tgz "https://github.com/prometheus/blackbox_exporter/releases/download/v${VER}/blackbox_exporter-${VER}.linux-amd64.tar.gz"
  tar xzf /tmp/bb.tgz -C /tmp
  install -m0755 "/tmp/blackbox_exporter-${VER}.linux-amd64/blackbox_exporter" /opt/blackbox-exporter/blackbox_exporter
  rm -rf /tmp/bb.tgz "/tmp/blackbox_exporter-${VER}.linux-amd64"
fi
id blackbox >/dev/null 2>&1 || useradd -rs /usr/sbin/nologin blackbox
chown -R blackbox:blackbox /opt/blackbox-exporter
cat > /etc/systemd/system/blackbox-exporter.service <<'EOF'
[Unit]
Description=Prometheus Blackbox Exporter
After=network-online.target
Wants=network-online.target
[Service]
User=blackbox
Group=blackbox
ExecStart=/opt/blackbox-exporter/blackbox_exporter --config.file=/opt/blackbox-exporter/blackbox.yml --web.listen-address=0.0.0.0:9115
AmbientCapabilities=CAP_NET_RAW
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now blackbox-exporter >/dev/null 2>&1
sleep 3
echo "blackbox: $(systemctl is-active blackbox-exporter)"
curl -fsS --max-time 5 "http://127.0.0.1:9115/-/healthy" 2>&1 | head -1 || true
