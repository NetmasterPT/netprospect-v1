#!/bin/bash
# run-parallel-tlds.sh — 3 streams PARALELOS por TLD (a máquina estava ~80% ociosa):
#   * SE: só extração (já enriquecido) — o backlog que faltava terminar.
#   * FI: enrich -> extração.
#   * NL: enrich -> extração.
# Cada extração é scoped por --tld (sem sobreposição entre streams). Startups
# escalonados p/ não colidirem as queries grandes. Tudo idempotente/retomável.
# Logs: out/{enrich,extract}-{se,fi,nl}-p.log ; sumário em out/parallel-orch.log
set -u
cd /root/Github/netprospect-v1
ORCH=out/parallel-orch.log
say() { echo "$(date +%T) $*" | tee -a "$ORCH"; }

EC=${CONC_ENRICH:-18}     # concorrência de enrich por stream
XC=${CONC_EXTRACT:-16}    # concorrência de extract por stream

left_tld() { # nº de qualificados .$1 ainda sem contactos
  docker exec -i netprospect-postgres-1 psql -U netprospect -d netprospect -tAc \
    "SELECT count(*) FROM sites WHERE qualified AND contacts_checked_at IS NULL AND domain LIKE '%.$1';" 2>/dev/null | tr -d '[:space:]'
}

extract_loop() { # $1=tld
  local tld=$1
  while :; do
    node extract-contacts.js --tld="$tld" --concurrency="$XC" > "out/extract-$tld-p.log" 2>&1
    local left; left=$(left_tld "$tld")
    say "extract .$tld: passada feita | por extrair=${left:-?}"
    [ "${left:-1}" = "0" ] && break
    sleep 20
  done
  say "extract .$tld: COMPLETO"
}

enrich_then_extract() { # $1=tld
  local tld=$1
  say "enrich .$tld a começar (conc $EC)"
  node enrich-sites.js --input="out/dominios_$tld.txt" --concurrency="$EC" > "out/enrich-$tld-p.log" 2>&1
  say "enrich .$tld feito -> extract"
  extract_loop "$tld"
}

say "=== ARRANQUE: SE(extract) + FI(enrich->extract) + NL(enrich->extract) ==="
extract_loop se &            # backlog SE (já enriquecido)
sleep 8
enrich_then_extract fi &     # FI
sleep 8
enrich_then_extract nl &     # NL
wait
say "=== TODOS OS STREAMS COMPLETOS ==="
