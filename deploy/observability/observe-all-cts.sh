#!/usr/bin/env bash
# observe-all-cts.sh — corre-se NUM nó Proxmox. Instala node-exporter (:9100) + Alloy (journald→Loki)
# em TODOS os CTs em execução (via pct push/exec, sem precisar de SSH/tailscale nos CTs).
#   bash observe-all-cts.sh <LOKI_URL>     # ex: http://10.10.10.16:3100 (hel1) ou http://100.95.20.65:3100 (de1)
set -uo pipefail
LOKI_URL="${1:?falta o LOKI_URL (arg 1)}"
NEVER=1.8.2; AVER=1.5.1
D=/tmp/obs-bins; mkdir -p "$D"; cd "$D"
[ -f node_exporter ] || { echo "[dl] node_exporter"; curl -fsSL "https://github.com/prometheus/node_exporter/releases/download/v${NEVER}/node_exporter-${NEVER}.linux-amd64.tar.gz" | tar xz && cp "node_exporter-${NEVER}.linux-amd64/node_exporter" . ; }
[ -f alloy ] || { echo "[dl] alloy"; curl -fsSL "https://github.com/grafana/alloy/releases/download/v${AVER}/alloy-linux-amd64.zip" -o a.zip && unzip -o a.zip >/dev/null && mv alloy-linux-amd64 alloy ; }
chmod +x node_exporter alloy

cat > "$D/node_exporter.service" <<'U'
[Unit]
Description=Node Exporter
After=network-online.target
[Service]
User=root
ExecStart=/usr/local/bin/node_exporter --web.listen-address=0.0.0.0:9100
Restart=on-failure
[Install]
WantedBy=multi-user.target
U
cat > "$D/alloy.service" <<'U'
[Unit]
Description=Grafana Alloy (journald -> Loki)
After=network-online.target
[Service]
ExecStart=/usr/local/bin/alloy run /etc/alloy/config-journald.alloy --storage.path=/var/lib/alloy --server.http.listen-addr=127.0.0.1:12346
Restart=on-failure
[Install]
WantedBy=multi-user.target
U

for id in $(pct list | awk 'NR>1 && $2=="running"{print $1}'); do
  hn=$(pct exec "$id" -- hostname -s 2>/dev/null | tr -d '\r\n'); [ -z "$hn" ] && hn="ct$id"
  if ! pct exec "$id" -- test -d /run/systemd/system 2>/dev/null; then echo "$id ($hn): sem systemd — salto"; continue; fi
  sed -e "s#__LOKI__#${LOKI_URL}#" -e "s#__HOST__#${hn}#" > "$D/cfg.alloy" <<'C'
logging {
  level = "warn"
}
loki.write "d" {
  endpoint {
    url = "__LOKI__/loki/api/v1/push"
  }
}
loki.source.journal "j" {
  max_age    = "12h"
  labels     = { job = "journald" }
  forward_to = [loki.process.h.receiver]
}
loki.process "h" {
  stage.static_labels {
    values = { host = "__HOST__" }
  }
  forward_to = [loki.write.d.receiver]
}
C
  pct exec "$id" -- mkdir -p /etc/alloy /var/lib/alloy /usr/local/bin 2>/dev/null
  pct push "$id" "$D/node_exporter" /usr/local/bin/node_exporter 2>/dev/null
  pct push "$id" "$D/alloy" /usr/local/bin/alloy 2>/dev/null
  pct exec "$id" -- chmod +x /usr/local/bin/node_exporter /usr/local/bin/alloy 2>/dev/null
  pct push "$id" "$D/cfg.alloy" /etc/alloy/config-journald.alloy 2>/dev/null
  pct push "$id" "$D/node_exporter.service" /etc/systemd/system/node_exporter.service 2>/dev/null
  pct push "$id" "$D/alloy.service" /etc/systemd/system/alloy.service 2>/dev/null
  pct exec "$id" -- systemctl daemon-reload 2>/dev/null
  pct exec "$id" -- systemctl enable --now node_exporter alloy >/dev/null 2>&1 || true
  echo "$id ($hn): node=$(pct exec "$id" -- systemctl is-active node_exporter 2>/dev/null) alloy=$(pct exec "$id" -- systemctl is-active alloy 2>/dev/null)"
done
echo "=== observe-all-cts DONE ==="
