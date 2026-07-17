#!/usr/bin/env bash
# NetProspect — reporter de telemetria de host STANDALONE.
#
# Para máquinas de INFRA que NÃO têm o repo (ex.: np-db — LXC com PostgreSQL + PgBouncer NATIVOS, sem
# Docker, de propósito p/ recursos nativos). Usa a MESMA recolha da frota via metrics-lib.sh: /proc
# (CPU/RAM/disco/IO/rede) + latências + (se houver Docker) containers + systemd (serviços do sistema
# base como pseudo-containers, com estado/RAM/CPU/journalctl). Corre por um systemd timer (~5 min).
#
# Instalação: copiar metrics-report.sh + metrics-lib.sh p/ o mesmo dir (ex.: /root/). Config em
# /etc/netprospect-metrics.env (ou METRICS_ENV=<path>). Ver metrics.env.example.
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${METRICS_ENV:-/etc/netprospect-metrics.env}"
# shellcheck disable=SC1090
[ -f "$CFG" ] && { set -a; . "$CFG"; set +a; }
: "${FLEET_HOST:?FLEET_HOST em falta}" ; : "${SERVER_URL:?SERVER_URL em falta}"
[ -f "$SELF/metrics-lib.sh" ] || { echo "falta $SELF/metrics-lib.sh (copia-o para junto deste script)"; exit 1; }
# shellcheck source=metrics-lib.sh
. "$SELF/metrics-lib.sh"
if collect_and_post; then
  echo "métricas enviadas ($FLEET_HOST)"
else
  echo "envio de métricas falhou" >&2; exit 1
fi
