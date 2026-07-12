#!/bin/bash
# Alimenta a fila DEDICADA do DE1 (NP_JOBS_DE1 / de1.jobs.*), que ele consome sem competir
# com o HEL1 na workqueue partilhada (onde ficava esfomeado). Mantém ~1000 jobs lá sempre
# que o pool principal tem backlog. Enfileira só o hash-shard do DE1 ⇒ zero duplicados.
set -u
cd "$(dirname "$0")/.."
export NATS_URL="${NATS_URL:-nats://localhost:4222}"
TARGET=${DE1_QUEUE_TARGET:-1000}
MAIN_MIN=${DE1_MAIN_MIN:-5000}
SHARD=${DE1_SHARD:-0/5}
while true; do
  read -r MAIN DE1P <<< "$(timeout 20 node scripts/queue-depth.mjs fingerprint 2>/dev/null)"
  MAIN=${MAIN:-0}; DE1P=${DE1P:-999999}
  if [ "$MAIN" -gt "$MAIN_MIN" ] && [ "$DE1P" -lt "$TARGET" ]; then
    TOP=$((TARGET - DE1P))
    OUT=$(JOB_STREAM=NP_JOBS_DE1 JOB_SUBJECT_PREFIX=de1. timeout 300 node enqueue-domain-health.js \
      --only=cms --shard="$SHARD" --subject-prefix=de1. --limit="$TOP" 2>&1)
    echo "$(date -Is) main=$MAIN de1=$DE1P → topup=$TOP | $(echo "$OUT" | tail -1)"
  fi
  sleep 15
done
