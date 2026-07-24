#!/usr/bin/env sh
# observability-alpine.sh — onboard do hel1-npm (Alpine CT) à observabilidade da frota.
# Idempotente. O obs-vm-install.sh da frota assume systemd (Debian) → NÃO serve em Alpine/OpenRC;
# este é o equivalente. Instala: node-exporter (host), cadvisor (containers), + o env do agente de
# métricas (a página Servidores). Correr DENTRO do CT (root@100.89.244.50).
#
#   sh deploy/npmplus/observability-alpine.sh
#
# Depois, na máquina de gestão: adicionar 100.89.244.50:{9100,8098} ao prometheus.yml (jobs node+cadvisor)
# e aplicar com  deploy/observability/push-configs.sh --only prometheus  (valida com promtool + SIGHUP).
set -u
TAILNET_IP="${TAILNET_IP:-100.89.244.50}"
SERVER_URL="${SERVER_URL:-http://100.114.17.74:3001}"

echo "== 1) node-exporter (host) — apk + OpenRC (persistente) =="
apk add --quiet prometheus-node-exporter prometheus-node-exporter-openrc
grep -q 9100 /etc/conf.d/node-exporter 2>/dev/null || \
  echo 'ARGS="--web.listen-address=0.0.0.0:9100"' >> /etc/conf.d/node-exporter
rc-update add node-exporter default 2>/dev/null || true
rc-service node-exporter restart

echo "== 2) cadvisor (containers) — mesmo spec da frota (:8098, net=host) =="
docker rm -f cadvisor 2>/dev/null || true
docker run -d --name cadvisor --restart unless-stopped --privileged --network host \
  -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro \
  -v /var/lib/docker:/var/lib/docker:ro -v /dev/disk:/dev/disk:ro \
  gcr.io/cadvisor/cadvisor:v0.49.1 \
  --listen_ip="$TAILNET_IP" --port=8098 --docker_only=true \
  --housekeeping_interval=30s --store_container_labels=false

echo "== 3) agente de métricas (página Servidores) — /opt/np/report.sh já existe; falta o env =="
[ -f /etc/netprospect-metrics.env ] || \
  printf 'FLEET_HOST=hel1-npm\nSERVER_URL=%s\nFLEET_PULL_TOKEN=\nDIRECTUS_PING_URL=\n' "$SERVER_URL" \
  > /etc/netprospect-metrics.env
chmod 600 /etc/netprospect-metrics.env

# NB: logs → Loki (Alloy) ficam por fazer — o Alloy da frota também é systemd; em Alpine seria apk/OpenRC (TODO).
echo "OK. Verificar: curl -s -o /dev/null -w '%{http_code}' http://$TAILNET_IP:9100/metrics ; idem :8098"
