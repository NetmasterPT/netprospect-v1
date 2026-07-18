#!/usr/bin/env bash
# install-loki.sh — corre-se DENTRO do CT hel1-loki (via pct exec). Instala o Loki single-binary + systemd.
# O config vem por pct push para /etc/loki/loki.yaml (ver deploy/observability/loki/loki.yaml).
set -euo pipefail
VER=3.2.2
if [ ! -x /usr/local/bin/loki ] || ! /usr/local/bin/loki --version 2>&1 | grep -q "$VER"; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq unzip curl ca-certificates >/dev/null 2>&1
  curl -fsSL -o /tmp/loki.zip "https://github.com/grafana/loki/releases/download/v${VER}/loki-linux-amd64.zip"
  unzip -o /tmp/loki.zip -d /tmp >/dev/null
  install -m0755 /tmp/loki-linux-amd64 /usr/local/bin/loki
  rm -f /tmp/loki.zip /tmp/loki-linux-amd64
fi
id loki >/dev/null 2>&1 || useradd -rs /usr/sbin/nologin loki
mkdir -p /etc/loki /var/lib/loki/chunks /var/lib/loki/rules /var/lib/loki/compactor
chown -R loki:loki /var/lib/loki /etc/loki
cat > /etc/systemd/system/loki.service <<'EOF'
[Unit]
Description=Grafana Loki
After=network-online.target
Wants=network-online.target
[Service]
User=loki
Group=loki
ExecStart=/usr/local/bin/loki -config.file=/etc/loki/loki.yaml
Restart=on-failure
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now loki >/dev/null 2>&1
sleep 5
echo "loki: $(systemctl is-active loki)"
curl -fsS --max-time 5 http://127.0.0.1:3100/ready 2>&1 | head -1 || true
