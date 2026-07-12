#!/bin/bash
# Enfileira whois para os TLDs com lookup funcional (RDAP .nl/.no/.fi + port-43 .se).
# O .pt fica DE FORA (precisa de WhoisXML key). Resume por whois_checked_at (o handler
# escreve-o SEMPRE) ⇒ converge. --shard-not=0/5 salta o shard do DE1 (feeder alimenta-o
# pela fila dedicada, com o IP alemão ⇒ quota de rate-limit própria).
set -u
cd "$(dirname "$0")/.."
export NATS_URL="${NATS_URL:-nats://localhost:4222}"
SHARD_NOT=${DE1_SHARD:-0/5}
for tld in ${WHOIS_TLDS:-nl se no fi}; do
  for try in 1 2 3 4 5; do
    if node enqueue-domain-health.js --only=whois --tld="$tld" --shard-not="$SHARD_NOT"; then
      echo "$(date -Is) whois .$tld ENFILEIRADO (try $try)"; break
    fi
    echo "$(date -Is) whois .$tld falhou (try $try) — retry em 15s"; sleep 15
  done
done
echo "$(date -Is) === whois: todos os TLDs enfileirados ==="
