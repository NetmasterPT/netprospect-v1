# DEBUGGING-TODO — watchlist do monitor de saúde

Lista do que estamos **à procura** ou a **testar** agora. O monitor de saúde (loop de 15 min) dá
**prioridade** a qualquer erro relacionado com estes itens. Edita à vontade: adiciona uma hipótese
quando estás a testar algo novo, marca `[resolvido]` quando fechares.

> **FONTE DE LOGS (importante para o monitor):** a telemetria/logs da frota NÃO está no
> `netprospect-redis-1` (hel1) — esse está sempre vazio. Os workers reportam para o **Redis do
> np-server** (`redis://100.114.17.74:6379`, container `server-redis-1`). Para o sinal de logs de TODA
> a frota, usa o endpoint do dashboard: `curl -s --max-time 15 http://100.114.17.74:3001/api/logs`
> (host + linha de cada worker). `docker logs` dos containers hel1 = fallback secundário (só hel1).

> Formato de cada item: `- [ ] <área> — o que observar / o que seria um problema`. Move para
> **Conhecido/esperado** o que NÃO é bug (para o monitor não reportar ruído).

## A vigiar (ativo)

- [ ] **Snapshot-regen backfill** (`fetch` com `snapshotOnly`) — deve drenar a ~9-10/s e a indústria
  deve subir. Problema se: `fetch` deixa de drenar (pending estagnado), pico de falhas no `fetch`, ou
  a indústria não aumenta apesar de o `fetch` correr. Código: `worker/handlers.mjs` (handleFetch),
  `worker/worker.mjs` (industry).
- [ ] **Cobertura >55 (datacenter)** — `lighthouse`/`nuclei`/`industry` devem chegar a 0 pendentes.
  Problema se ficarem presos com `redelivered` a subir até esgotar `maxDeliver` (órfãos).
- [ ] **Auto-deploy PULL** — os agentes de cada host devem correr sem erro. Problema se: um host para
  de puxar (log do agente sem "sem alterações"/recreate), recreate em loop, ou containers duplicados.
  Ver `deploy/agent/pull-deploy.sh` + `docs/runbook-laptop-autodeploy.md`.
- [ ] **Escrita PG (write-behind / DIRECT_PG_WRITE)** — problema se aparecerem erros de PG/PgBouncer
  ("too many clients", "SASL", timeouts) nos logs. Código: `lib/pgwrite.js`.

## Conhecido/esperado (NÃO reportar como bug)

- **verify "pool exhausted — sem quota"** — a quota da API é 100/dia; os `↻ verify` são esperados até
  ao reset diário. Só reportar se falhar por OUTRA razão (ex.: erro de rede persistente, não quota).
- **gmb lento no laptop** — o GMB é residencial-only (só `gpedro-laptop`); drenagem lenta e
  dependente do portátil estar online é estrutural, não é bug.
- **Directus "Service unavailable / Under pressure" (503)** — transitório; o classificador faz `nak`
  (retry), não `term`. Só é problema se um job for **terminado** (`✗`) por causa disto (perda de job).
- **`fetch` com centenas de milhar de pendentes** — é o backfill base-wide em curso (~1 dia). Normal.
