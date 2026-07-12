#!/bin/bash
# Backfill de cms/fingerprint no pool PRINCIPAL, em lotes controlados.
# Enfileira 50k só quando a fila desce dos 5000 (evita o pico de load que já nos rebentou).
# --shard-not=0/5 → salta o shard do DE1 (que o feeder alimenta) ⇒ zero duplicados.
set -u
cd "$(dirname "$0")/.."
export NATS_URL="${NATS_URL:-nats://localhost:4222}"
LOW=${CMS_LOW_WATERMARK:-5000}
BATCH=${CMS_BATCH:-50000}
SHARD_NOT=${DE1_SHARD:-0/5}
while true; do
  MAIN=$(timeout 20 node scripts/queue-depth.mjs fingerprint 2>/dev/null | awk '{print $1+0}')
  if [ "${MAIN:-999999}" -lt "$LOW" ]; then
    OUT=$(timeout 900 node enqueue-domain-health.js --only=cms --shard-not="$SHARD_NOT" --limit="$BATCH" 2>&1)
    echo "$(date -Is) main=$MAIN → lote | $(echo "$OUT" | tail -1)"
    echo "$OUT" | grep -qE "Concluído. 0 sites" && { echo "$(date -Is) === CMS (main) COMPLETO ==="; exit 0; }
  else
    echo "$(date -Is) main=$MAIN (acima do watermark $LOW — sem lote)"
  fi
  sleep 60
done
