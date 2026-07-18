#!/usr/bin/env bash
# install-node-exporter-pve.sh — node-exporter NATIVO num nó Proxmox (métricas OS do host + ZFS).
# Corre-se NO nó PVE (root): bind na tailnet, collectors zfs+systemd+textfile, + um textfile collector de zpool
# (health/capacidade/fragmentação/scrub por pool, que o collector zfs nativo não dá).
#
#   bash install-node-exporter-pve.sh <TAILNET_IP>
#
# Idempotente. Ver deploy/observability/prometheus (job 'node') + docs/observability.md.
set -euo pipefail
TS_IP="${1:?falta o TAILNET_IP do nó (arg 1)}"
VER="1.8.2"
ARCH="linux-amd64"

if [ ! -x /usr/local/bin/node_exporter ] || ! /usr/local/bin/node_exporter --version 2>&1 | grep -q "$VER"; then
  echo "[node_exporter] a instalar v$VER"
  cd /tmp
  curl -fsSL "https://github.com/prometheus/node_exporter/releases/download/v${VER}/node_exporter-${VER}.${ARCH}.tar.gz" -o ne.tgz
  tar xzf ne.tgz
  install -m0755 "node_exporter-${VER}.${ARCH}/node_exporter" /usr/local/bin/node_exporter
  rm -rf ne.tgz "node_exporter-${VER}.${ARCH}"
fi

id node_exporter >/dev/null 2>&1 || useradd -rs /usr/sbin/nologin node_exporter
mkdir -p /var/lib/node_exporter/textfile
chown -R node_exporter:node_exporter /var/lib/node_exporter

# textfile collector de zpool (corre como root via timer; node_exporter só lê o ficheiro)
cat > /usr/local/bin/zpool-textfile.sh <<'ZP'
#!/usr/bin/env bash
set -uo pipefail
OUT=/var/lib/node_exporter/textfile/zpool.prom
tmp="$(mktemp)"
{
  echo "# HELP zpool_health ZFS pool health (1=ONLINE, 0=outro)"
  echo "# TYPE zpool_health gauge"
  zpool list -Hp -o name,size,alloc,free,health,frag,cap 2>/dev/null | while IFS=$'\t' read -r name size alloc free health frag cap; do
    h=0; [ "$health" = "ONLINE" ] && h=1
    printf 'zpool_health{pool="%s"} %s\n' "$name" "$h"
    printf 'zpool_size_bytes{pool="%s"} %s\n' "$name" "$size"
    printf 'zpool_alloc_bytes{pool="%s"} %s\n' "$name" "$alloc"
    printf 'zpool_free_bytes{pool="%s"} %s\n' "$name" "$free"
    printf 'zpool_capacity_ratio{pool="%s"} %s\n' "$name" "$(echo "$cap" | tr -d '%')"
    printf 'zpool_fragmentation_ratio{pool="%s"} %s\n' "$name" "$(echo "$frag" | tr -d '%')"
  done
  # scrub: 1 se em curso, e idade do último scrub
  zpool status 2>/dev/null | awk '/pool:/{p=$2} /scan:/{if(/in progress/){printf "zpool_scrub_in_progress{pool=\"%s\"} 1\n",p}else{printf "zpool_scrub_in_progress{pool=\"%s\"} 0\n",p}}'
} > "$tmp" 2>/dev/null
mv "$tmp" "$OUT"
chmod 0644 "$OUT"   # o node_exporter (user não-root) tem de o ler
ZP
chmod +x /usr/local/bin/zpool-textfile.sh
/usr/local/bin/zpool-textfile.sh || true

cat > /etc/systemd/system/zpool-textfile.service <<EOF
[Unit]
Description=NetProspect zpool textfile collector
[Service]
Type=oneshot
ExecStart=/usr/local/bin/zpool-textfile.sh
EOF
cat > /etc/systemd/system/zpool-textfile.timer <<EOF
[Unit]
Description=zpool textfile a cada 60s
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/node_exporter.service <<EOF
[Unit]
Description=Prometheus Node Exporter
After=network-online.target
Wants=network-online.target
[Service]
User=node_exporter
Group=node_exporter
ExecStart=/usr/local/bin/node_exporter \\
  --web.listen-address=${TS_IP}:9100 \\
  --collector.systemd \\
  --collector.zfs \\
  --collector.textfile.directory=/var/lib/node_exporter/textfile
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now zpool-textfile.timer node_exporter.service >/dev/null 2>&1
sleep 2
echo "node_exporter: $(systemctl is-active node_exporter) | zpool-timer: $(systemctl is-active zpool-textfile.timer)"
echo "listen: ${TS_IP}:9100"
