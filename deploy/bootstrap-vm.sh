#!/usr/bin/env bash
# bootstrap-vm.sh — corre-se UMA vez numa VM nova (Debian/Ubuntu) para a pôr na frota.
# Instala Docker + Tailscale, junta-a ao tailnet com um hostname, e clona o repo. Depois
# disto, o deploy da stack (compose + env do role) é feito remotamente via tailnet.
#
# Uso (como root na VM nova):
#   curl -fsSL <raw-url>/deploy/bootstrap-vm.sh | bash -s -- <TS_AUTHKEY> <HOSTNAME> [TAGS]
#   # ou, com o repo já clonado:
#   bash deploy/bootstrap-vm.sh <TS_AUTHKEY> <HOSTNAME> [TAGS]
#
# Exemplo:
#   bash bootstrap-vm.sh tskey-auth-xxxx np-oracle-a1-1 tag:worker
#
# Idempotente: pode correr-se de novo sem estragar nada.
set -euo pipefail

TS_AUTHKEY="${1:?falta o Tailscale auth key (arg 1)}"
HOSTNAME_TS="${2:?falta o hostname para o tailnet (arg 2)}"
TS_TAGS="${3:-tag:worker}"
REPO_URL="${REPO_URL:-https://github.com/NetmasterPT/netprospect-v1.git}"
REPO_DIR="${REPO_DIR:-/root/netprospect-v1}"

log() { echo -e "\033[1;36m[bootstrap]\033[0m $*"; }

# 1) Docker (idempotente — o get.docker.com salta se já estiver)
if ! command -v docker >/dev/null 2>&1; then
  log "a instalar o Docker..."
  curl -fsSL https://get.docker.com | sh
else
  log "Docker já instalado ($(docker --version))"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# 2) Tailscale
if ! command -v tailscale >/dev/null 2>&1; then
  log "a instalar o Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi
log "a juntar ao tailnet como '$HOSTNAME_TS' (tags: $TS_TAGS)..."
# --ssh: SSH sobre o tailnet (auth pelas ACLs, sem gerir chaves). --accept-routes p/ alcançar o CT.
tailscale up --authkey="$TS_AUTHKEY" --hostname="$HOSTNAME_TS" \
  --advertise-tags="$TS_TAGS" --ssh --accept-routes --reset
TS_IP="$(tailscale ip -4 | head -1)"
log "tailnet IP: $TS_IP"

# 3) Repo (shallow — só p/ os ficheiros de compose/deploy; os workers usam a imagem, não o código)
if [ ! -d "$REPO_DIR/.git" ]; then
  log "a clonar o repo em $REPO_DIR..."
  git clone --depth 1 "$REPO_URL" "$REPO_DIR" 2>/dev/null || { apt-get update -qq && apt-get install -y -qq git && git clone --depth 1 "$REPO_URL" "$REPO_DIR"; }
else
  log "repo já presente — git pull"; git -C "$REPO_DIR" pull --ff-only 2>/dev/null || true
fi

# 4) Resumo p/ o operador da frota (Claude) fazer o deploy do role
cat <<SUMMARY

\033[1;32m✓ VM pronta.\033[0m Passa isto ao operador da frota:
  hostname : $HOSTNAME_TS
  tailnet  : $TS_IP
  arch     : $(uname -m)
  cpu/ram  : $(nproc)c / $(free -g | awk '/Mem:/{print $2}')GB
  disco    : $(df -h / | awk 'NR==2{print $4" livre"}')
  repo     : $REPO_DIR

Deploy do role (feito remotamente):  ssh root@$TS_IP  →  cd $REPO_DIR && <compose do role>
SUMMARY
