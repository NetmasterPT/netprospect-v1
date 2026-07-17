#!/usr/bin/env bash
# NetProspect — reporter de telemetria para hosts PROXMOX (hel1-pve, de1-pve).
#
# Corre como user NÃO-ROOT (ex.: npmetrics) por um systemd timer (~5 min). Reusa metrics-lib.sh para o
# host (/proc: CPU/RAM/disco/IO/rede) + serviços systemd (com logs via grupo systemd-journal) e acrescenta
# os LXC + VMs do nó via extra_units_json (chama o wrapper root np-pve-collect.sh por sudo -n). Faz POST
# /api/fleet/metrics/<FLEET_HOST>. Sem docker nestes hosts (containers_json devolve []).
#
# Instalação: metrics-lib.sh + proxmox-report.sh no dir do user (ex.: /opt/np/); np-pve-collect.sh em
# /usr/local/bin (root); um oneshot ROOT (np-pve-units.{service,timer}) corre np-pve-collect e escreve
# /run/np-pve-units.json que este reporter lê (sem privilégios). user no grupo systemd-journal; config
# em /etc/netprospect-metrics.env (FLEET_HOST=hel1-pve|de1-pve, SERVER_URL, ...).
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${METRICS_ENV:-/etc/netprospect-metrics.env}"
# shellcheck disable=SC1090
[ -f "$CFG" ] && { set -a; . "$CFG"; set +a; }
: "${FLEET_HOST:?FLEET_HOST em falta}" ; : "${SERVER_URL:?SERVER_URL em falta}"
[ -f "$SELF/metrics-lib.sh" ] || { echo "falta $SELF/metrics-lib.sh"; exit 1; }

# LXC + VMs do nó — lidos de um ficheiro que um oneshot ROOT (np-pve-units.service) escreve a cada ciclo.
# Assim o reporter fica SEM privilégios (o PVE não traz sudo; pvesh/pct/qm exigem root). ≤5min de idade.
extra_units_json() { cat "${PVE_UNITS_FILE:-/run/np-pve-units.json}" 2>/dev/null || printf '[]'; }

# shellcheck source=metrics-lib.sh
. "$SELF/metrics-lib.sh"
if collect_and_post; then echo "métricas enviadas ($FLEET_HOST)"; else echo "envio de métricas falhou" >&2; exit 1; fi
