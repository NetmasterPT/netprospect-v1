#!/usr/bin/env bash
# obs-vm-install.sh — self-contained: node-exporter + Alloy (journald + docker se houver) numa VM Debian.
# Descarrega os binários dentro da VM (para VMs sem pct push, via qm guest exec).
#   bash obs-vm-install.sh <HOSTLABEL> [LOKI_URL]
set -uo pipefail
HOSTLABEL="${1:?falta HOSTLABEL}"
LOKI_URL="${2:-http://10.10.10.16:3100}"
export DEBIAN_FRONTEND=noninteractive
command -v unzip >/dev/null 2>&1 || apt-get install -y -qq unzip curl ca-certificates >/dev/null 2>&1 || true
cd /tmp
if [ ! -x /usr/local/bin/node_exporter ]; then
  curl -fsSL https://github.com/prometheus/node_exporter/releases/download/v1.8.2/node_exporter-1.8.2.linux-amd64.tar.gz | tar xz
  install -m0755 node_exporter-1.8.2.linux-amd64/node_exporter /usr/local/bin/node_exporter
fi
if [ ! -x /usr/local/bin/alloy ]; then
  curl -fsSL https://github.com/grafana/alloy/releases/download/v1.5.1/alloy-linux-amd64.zip -o alloy.zip
  unzip -o alloy.zip >/dev/null
  install -m0755 alloy-linux-amd64 /usr/local/bin/alloy
fi
mkdir -p /etc/alloy /var/lib/alloy
{
  echo 'logging { level = "warn" }'
  echo "loki.write \"d\" { endpoint { url = \"${LOKI_URL}/loki/api/v1/push\" } }"
  echo 'loki.source.journal "j" {'
  echo '  max_age    = "12h"'
  echo '  labels     = { job = "journald" }'
  echo '  forward_to = [loki.process.h.receiver]'
  echo '}'
  if [ -S /var/run/docker.sock ]; then
    echo 'discovery.docker "dc" { host = "unix:///var/run/docker.sock" }'
    echo 'discovery.relabel "dc" {'
    echo '  targets = discovery.docker.dc.targets'
    echo '  rule { source_labels = ["__meta_docker_container_name"] regex = "/(.*)" target_label = "container" }'
    echo '}'
    echo 'loki.source.docker "dc" {'
    echo '  host       = "unix:///var/run/docker.sock"'
    echo '  targets    = discovery.relabel.dc.output'
    echo '  forward_to = [loki.process.h.receiver]'
    echo '}'
  fi
  echo 'loki.process "h" {'
  echo "  stage.static_labels { values = { host = \"${HOSTLABEL}\" } }"
  echo '  forward_to = [loki.write.d.receiver]'
  echo '}'
} > /etc/alloy/config.alloy
printf '[Unit]\nDescription=Node Exporter\nAfter=network-online.target\n[Service]\nExecStart=/usr/local/bin/node_exporter --web.listen-address=0.0.0.0:9100\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/node_exporter.service
printf '[Unit]\nDescription=Grafana Alloy\nAfter=network-online.target\n[Service]\nExecStart=/usr/local/bin/alloy run /etc/alloy/config.alloy --storage.path=/var/lib/alloy --server.http.listen-addr=127.0.0.1:12346\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/alloy.service
systemctl daemon-reload
systemctl enable --now node_exporter alloy >/dev/null 2>&1
echo "DONE ${HOSTLABEL} node=$(systemctl is-active node_exporter) alloy=$(systemctl is-active alloy)"
