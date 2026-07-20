#!/usr/bin/env bash
# Setup de uma VM de ENVIO (docker-mailserver). Sobe o DMS, cria a mailbox, gera o DKIM e IMPRIME os
# registos DNS a criar (MX/A/SPF/DKIM/DMARC) + o PTR a pedir. Correr NA VM, depois de preencher .env.
# Idempotente: pode correr as vezes que precisar. Ver ./README.md.
#
# Uso: ./setup.sh <mailbox@dominio> [password]
#   (sem password → gera uma forte e imprime-a no fim; mete-a em config/sending-accounts.json)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

[ -f .env ] || { echo "✗ falta .env — copia .env.example e preenche"; exit 1; }
set -a; . ./.env; set +a
MBOX="${1:?uso: ./setup.sh <mailbox@dominio> [password]}"
DOMAIN="${MBOX#*@}"
PASS="${2:-$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | head -c 20)}"
IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || echo '<IP-DA-VM>')"

echo "→ 1/4 a subir o docker-mailserver ($MAIL_HOSTNAME)…"
docker compose up -d
echo "   à espera do arranque…"; sleep 8

echo "→ 2/4 a criar a mailbox $MBOX…"
docker exec mailserver setup email add "$MBOX" "$PASS" 2>&1 | grep -vi 'already exists' || true

echo "→ 3/4 a gerar a chave DKIM ($DOMAIN)…"
docker exec mailserver setup config dkim 2>&1 | tail -2 || true
DKIM_FILE="./config/opendkim/keys/${DOMAIN}/mail.txt"
DKIM_REC="$( [ -f "$DKIM_FILE" ] && tr -d '\n\t"' < "$DKIM_FILE" | sed 's/.*(\(.*\)).*/\1/' | tr -s ' ' || echo '<corre setup config dkim e vê ./config/opendkim/keys/'"$DOMAIN"'/mail.txt>')"

echo "→ 4/4 registos DNS a criar em $DOMAIN (+ PTR a pedir ao provedor do IP):"
cat <<DNS

  ; ── DNS de $DOMAIN ──────────────────────────────────────────────
  $MAIL_HOSTNAME.        A     $IP
  $DOMAIN.               MX 10 $MAIL_HOSTNAME.
  $DOMAIN.               TXT   "v=spf1 ip4:$IP -all"
  _dmarc.$DOMAIN.        TXT   "v=DMARC1; p=none; rua=mailto:postmaster@$DOMAIN"
  mail._domainkey.$DOMAIN. TXT "$DKIM_REC"

  ; ── PTR (no painel do IP: Hetzner Robot / OpenProvider) ─────────
  $IP  ->  $MAIL_HOSTNAME     (tem de bater com o HELO/hostname do DMS)

DNS
echo "Mailbox: $MBOX"
[ -z "${2:-}" ] && echo "Password (guarda-a em config/sending-accounts.json): $PASS"
cat <<'NEXT'

Depois:
  1) cria os registos DNS acima + o PTR; verifica: dig +short -x <IP> == mail.<domínio>
  2) manda 1 teste p/ uma seed Gmail → "Mostrar original": SPF/DKIM/DMARC = pass; e https://mail-tester.com (>=9/10)
  3) regista a mailbox em config/sending-accounts.json (host=<domínio>, port=587, ver config/sending-accounts.example.json)
  4) warm-up: docs/outreach-ops/04-warmup.md (campaign-drip.js faz a rampa) — NÃO opcional
NEXT
