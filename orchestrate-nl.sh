#!/usr/bin/env bash
# orchestrate-nl.sh — leva o NL 100% pela job queue e encadeia o resto do pipeline
# no fim, para ficar tudo atualizado sem babysitting:
#   1) enqueue enrich (resume) + contacts (já-enriquecidos) do NL
#   2) espera enrich+contacts drenarem
#   3) enqueue domain-health NL (ssl/dnsprovider/whois)  [não pontua — DOMAIN_HEALTH_SKIP_SCORE]
#   4) espera drenarem
#   5) requalify + score-leads (bulk SQL) → scores/qualificação finais
# O worker-base (WORKER_ROLES=base) é quem processa. A fila NATS é durável (sobrevive a
# reinícios); se este script morrer, o trabalho continua — só o encadeamento se perde.
set -u
cd /root/Github/netprospect-v1
export NATS_URL="${NATS_URL:-nats://localhost:4222}"
LOG=out/orchestrate-nl.log
say() { echo "$(date +'%F %T') $*" | tee -a "$LOG"; }

# soma o `pending` das filas passadas como args, via /api/queues
qpending() {
  curl -s localhost:3001/api/queues 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);let t=0;for(const n of process.argv.slice(1))t+=(j.consumers.find(c=>c.name===n)||{}).pending||0;console.log(t)}catch{console.log(999999)}})" "$@"
}
# espera as filas ($@) esvaziarem (<50 pending), estável em 3 leituras seguidas
waitdrain() {
  local stable=0 p
  while :; do
    p=$(qpending "$@")
    say "  fila [$*] pending=${p} (load $(head -1 /proc/loadavg | awk '{print $1}'))"
    if [ "${p:-999999}" -le 50 ] 2>/dev/null; then stable=$((stable+1)); [ "$stable" -ge 3 ] && break; else stable=0; fi
    sleep 180
  done
  say "  → [$*] drenado."
}

say "===== ORCHESTRATE NL — início ====="
say "1) enqueue enrich (resume) + contacts (já-enriquecidos)"
node enqueue-enrich.js --input=out/dominios_nl.txt 2>&1 | tail -2 | tee -a "$LOG"
node enqueue-contacts.js --tld=nl 2>&1 | tail -2 | tee -a "$LOG"

say "2) esperar enrich + contacts drenarem (enrich cascata contacts)"
waitdrain enrich contacts

say "3) enqueue domain-health NL (ssl/dnsprovider/whois)"
node enqueue-domain-health.js --tld=nl --only=ssl,dnsprovider,whois 2>&1 | tail -2 | tee -a "$LOG"
say "4) esperar ssl/dnsprovider/whois drenarem"
waitdrain ssl dnsprovider whois

say "5) requalify + score-leads (bulk SQL — finais)"
node requalify.js 2>&1 | tail -3 | tee -a "$LOG"
node score-leads.js 2>&1 | tail -3 | tee -a "$LOG"

say "===== ORCHESTRATE NL — COMPLETO ====="
