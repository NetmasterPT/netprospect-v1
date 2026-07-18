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

# --- healthcheck contra "empty ring" pós-reboot ---------------------------------------------------
# O Loki single-binary pode ficar preso em "empty ring" a seguir a um reboot: o ingester não se
# regista no ring a tempo → /ready dá 503 e os pushes falham com 500, MAS o processo NÃO crasha, por
# isso o Restart=on-failure não apanha. Este timer reinicia o Loki se o /ready falhar 3 checks
# seguidos (~3 min), com contador em /run p/ não entrar em loop de restart. (Aconteceu no reboot do
# hel1 a 2026-07-18 e exigiu restart manual.)
cat > /usr/local/bin/loki-healthcheck.sh <<'HC'
#!/usr/bin/env bash
set -uo pipefail
STATE=/run/loki-healthcheck.fails
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3100/ready 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then rm -f "$STATE"; exit 0; fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE"
if [ "$n" -ge 3 ]; then
  logger -t loki-healthcheck "Loki /ready=$code há ${n} checks → restart"
  systemctl restart loki; rm -f "$STATE"
fi
HC
chmod +x /usr/local/bin/loki-healthcheck.sh
cat > /etc/systemd/system/loki-healthcheck.service <<EOF
[Unit]
Description=NetProspect Loki healthcheck (self-heal do empty-ring)
After=loki.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/loki-healthcheck.sh
EOF
cat > /etc/systemd/system/loki-healthcheck.timer <<EOF
[Unit]
Description=Loki healthcheck a cada 60s (arranca 90s após boot)
[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now loki loki-healthcheck.timer >/dev/null 2>&1
sleep 5
echo "loki: $(systemctl is-active loki) | healthcheck-timer: $(systemctl is-active loki-healthcheck.timer)"
curl -fsS --max-time 5 http://127.0.0.1:3100/ready 2>&1 | head -1 || true
