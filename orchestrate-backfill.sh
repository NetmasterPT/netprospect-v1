#!/bin/bash
# orchestrate-backfill.sh — dispara AUTOMATICAMENTE quando o NL (orchestrate-nl.sh)
# terminar e as filas estiverem drenadas. Enfileira o que falta em TODOS os TLDs:
#   fingerprint (--only=cms) · ssl · dnsprovider · contacts   (resume: só o que falta)
# + traffic ranking (bulk SQL) e finaliza com requalify + score-leads.
# Cada enqueue salta o que já está feito (resume por campo) — idempotente.
cd "$(dirname "$0")"
LOG=out/orchestrate-backfill.log
say(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
qpending(){ curl -s localhost:3001/api/queues 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);let t=0;for(const n of process.argv.slice(1)){const c=j.consumers.find(x=>x.name===n)||{};t+=(c.pending||0)+(c.ackPending||0)}console.log(t)}catch{console.log(999999)}})" "$@"; }
waitdrain(){ local stable=0 p; while :; do sleep 60; p=$(qpending "$@"); say "  fila [$*] pending=$p (load $(cut -d' ' -f1 /proc/loadavg))"; if [ "${p:-999999}" -le 100 ] 2>/dev/null; then stable=$((stable+1)); [ "$stable" -ge 3 ] && break; else stable=0; fi; done; }

say "== orchestrate-backfill: à espera que o NL (orchestrate-nl.sh) termine =="
while pgrep -f orchestrate-nl >/dev/null 2>&1; do sleep 120; done
say "orchestrate-nl terminou — a confirmar que as filas drenaram"
waitdrain enrich contacts ssl dnsprovider whois fingerprint score

say "1) traffic ranking (JOIN bulk contra o Tranco top-1M)"
bash backfill-traffic.sh 2>&1 | tail -8 | tee -a "$LOG"

say "2) enfileirar fingerprint(cms) + ssl + dnsprovider + contacts — todos os TLDs, só o que falta"
node enqueue-domain-health.js --only=cms         2>&1 | tail -2 | tee -a "$LOG"
node enqueue-domain-health.js --only=ssl         2>&1 | tail -2 | tee -a "$LOG"
node enqueue-domain-health.js --only=dnsprovider 2>&1 | tail -2 | tee -a "$LOG"
node enqueue-contacts.js                         2>&1 | tail -2 | tee -a "$LOG"

# whois via o router tiered (Part B): RDAP p/ .no/.nl/.fi, port-43 p/ .se (dá expiry).
# .pt SALTA-SE — sem RDAP + port-43 do DNS.pt filtra o nosso IP → só WhoisXML (espera keys);
# enfileirá-lo agora seria 87k × timeout de 10s a null. Rate-limited (RDAP_RATE_PER_SEC) → dias.
say "2b) enfileirar whois (RDAP .no/.nl/.fi + port-43 .se; .pt adiado p/ WhoisXML keys)"
for t in no nl fi se; do node enqueue-domain-health.js --only=whois --tld=$t 2>&1 | tail -1 | tee -a "$LOG"; done

say "3) esperar drenar (fingerprint + ssl + dnsprovider + contacts + whois)"
waitdrain fingerprint ssl dnsprovider contacts whois score

say "4) requalify + score-leads (finais, bulk SQL)"
node requalify.js   2>&1 | tail -3 | tee -a "$LOG"
node score-leads.js 2>&1 | tail -3 | tee -a "$LOG"
say "== BACKFILL COMPLETO (fingerprint+ssl+dnsprovider+contacts+traffic + rescore) =="
