# DEBUGGING-TODO — watchlist do monitor de saúde

Lista do que estamos **à procura** ou a **testar** agora. O monitor de saúde (loop de 15 min) dá
**prioridade** a qualquer erro relacionado com estes itens. Edita à vontade: adiciona uma hipótese
quando estás a testar algo novo, marca `[resolvido]` quando fechares.

> **CONSULTA A OBSERVABILIDADE PRIMEIRO (Alertmanager = fonte de verdade).** A stack (Prometheus →
> regras → Alertmanager) já deteta a maioria dos problemas de forma sempre-on. Começa CADA ronda por
> `curl -s --max-time 15 http://100.114.17.74:3001/api/alerts` → devolve os alertas ATIVOS
> (nome/severidade/host/consumer/summary). **Se vier vazio**, a frota está saudável nas dimensões
> cobertas por regras (dashboard/worker down · host CPU/RAM/disco/**swap** · latência Directus · **fila
> presa** `NetProspectQueueStuck` · **órfãos em fila terminada** `NetProspectQueueOrphans`) → NÃO precisas
> dos curls exaustivos; confirma só o deploy-watch e as AÇÕES. **Só investigas a fundo** (NATS/`/api/logs`)
> o que estiver a DISPARAR. As **AÇÕES continuam contigo** (não são regras): requeue de órfãos seguros,
> deploy-watch (baseline/observação), decisões de POISON, e o julgamento "isto é esperado?". A stack
> observa; tu decides e operas. (Endpoint: `dashboard/server.mjs` `/api/alerts`; regras nos grupos
> `netprospect` + `netprospect-queues` do Prometheus CT200 → Alertmanager CT203 → ntfy.)

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
- [ ] **subdomains — teto crt.sh (rate-limit por IP)** — o `maxAckPending` foi subido `4→8→16` pelo
  autoscaler (backlog ~4800, hosts `base` folgados). ⚠️ O autoscaler **só vê CPU** e vai continuar a pedir
  `16→32→…` porque **NÃO modela o crt.sh**, que é a fonte real do subdomains e **limita POR IP**. A 16/~5
  hosts `base` ≈ 3/IP (prudente). **Vigiar:** picos de falhas/`✗`/`↻` no `subdomains` com assinatura de
  crt.sh (429, `rate limit`, timeouts a subir, respostas vazias) → é o teto EXTERNO; **não subir mais**
  (nem seguir a sugestão do autoscaler) e, se persistir, **baixar** o `SUBDOMAINS_MAX_ACK`. A escala real é
  +IPs (como o gmb/verify), não +conc. Só subir acima de 16 se o crt.sh estiver limpo E o backlog o exigir.
- [ ] **Auto-deploy PULL** — os agentes de cada host devem correr sem erro. Problema se: um host para
  de puxar (log do agente sem "sem alterações"/recreate), recreate em loop, ou containers duplicados.
  Ver `deploy/agent/pull-deploy.sh` + `docs/runbook-laptop-autodeploy.md`.
- [ ] **Escrita PG (write-behind / DIRECT_PG_WRITE)** — problema se aparecerem erros de PG/PgBouncer
  ("too many clients", "SASL", timeouts) nos logs. Código: `lib/pgwrite.js`.
- [ ] **Gestão ativa de órfãos + retries (AÇÃO a cada ronda)** — o monitor está autorizado a operar as
  filas (não é alterar código, é operação). Cada ronda:
  1. Ler os **órfãos** e os **redelivered** por fila (via `/api/queues` — campos `orphans` e
     `redelivered` — ou NATS). **`fetch` fica de fora**: os ~500 órfãos são sites mortos que expiram
     pelo MaxAge (48h); não relançar.
  2. **Relançar** os órfãos das filas SEGURAS (`pending==0`, ≠fetch) com
     `curl -s -X POST http://100.114.17.74:3001/api/queues/<consumer>/orphans -H 'Content-Type: application/json' -d '{"mode":"requeue"}'`
     — recoloca-os em fila SEM purgar a fila toda (a guarda recusa se houver pendentes legítimos → não
     há perda). Os transitórios re-tentam e resolvem; usar `{"mode":"clean"}` para só cancelar sem relançar.
  3. **Rastreio de reincidentes (poison):** ANTES de relançar, amostrar os domínios dos órfãos e o erro
     deles (via `/api/logs` — procurar `✗`/`↻` desse job) e registar/atualizar em
     [`docs/orphan-offenders.md`](docs/orphan-offenders.md): `domínio · job · assinatura-de-erro ·
     nº-de-vezes-re-orfanado · 1º-visto · último-visto`.
  4. **Cortar o loop:** se um `(domínio+job)` reaparecer órfão **≥3 rondas com o MESMO erro**, marcar
     **POISON** em `docs/orphan-offenders.md`, **DEIXAR de relançar** esse job, e **reportar na conversa**
     para o utilizador decidir a política de retry (desistir de vez · max-N tentativas · janela de tempo ·
     cadência tipo 1×/dia). É o objetivo: retentar os transitórios, cortar os que ficam em loop.

- [ ] **Deploy-watch: detetar rebuilds + vigiar as VMs após a mudança (AÇÃO a cada ronda)** — o agente de
  pull de cada host faz `git pull` / puxa o `.env` central / recria os containers quando deteta mudanças.
  O monitor tem de **apanhar esses deploys e vigiar activamente a VM afetada durante ~3 rondas**, a testar o
  resultado (arranque, roles/consumers, logs, load, throughput, falhas). Procedimento completo e ficheiro de
  estado em [`docs/deploy-watch.md`](docs/deploy-watch.md). Cada ronda:
  1. **Detetar deploy** por host (via `/api/workers` + `/api/fleet/env/<host>`, sem SSH): `started` recuou /
     uptime caiu (**RECREATE**); `version` mudou (rebuild de imagem); **hash do env store** mudou (deploy a
     caminho); ou o conjunto de `consumers` mudou (roles novos). Comparar com a baseline da ronda anterior
     guardada em `docs/deploy-watch.md`.
  2. **Pôr sob observação** o host afetado por **K=3 rondas (~45 min)**, guardando a baseline pré-deploy.
  3. **Validar** a cada ronda: worker volta e estabiliza (`beat<90s`, uptime a crescer e não a resetar =
     não crash-loop); `consumers` batem com o `WORKER_ROLES` esperado; `fail1h/24h` não dispara vs baseline;
     load são; logs sem `✗`/stack-trace/`Cannot find`/`SyntaxError` novos após o restart; `done1h` a recuperar.
  4. **Veredicto:** saudável K rondas → **VALIDADO** (sai da observação); **regressão** (crash-loop, pico de
     falhas, erro novo, consumers errados) → abrir incidente + reportar na conversa.
  5. **Reescrever a baseline** em `docs/deploy-watch.md` no fim da ronda.
  Genérico sobre QUALQUER host que apareça — inclui os futuros `de-minio`, `hel1-analytics`, `np-server`,
  `np-db` quando entrarem no dashboard como VMs (mesmo modelo: git + `.env` central + agente a recriar).

## Conhecido/esperado (NÃO reportar como bug)

- **verify "pool exhausted — sem quota"** — a quota da API é 100/dia; os `↻ verify` são esperados até
  ao reset diário. Só reportar se falhar por OUTRA razão (ex.: erro de rede persistente, não quota).
- **gmb lento no laptop** — o GMB é residencial-only (só `gpedro-laptop`); drenagem lenta e
  dependente do portátil estar online é estrutural, não é bug.
- **Directus "Service unavailable / Under pressure" (503)** — transitório; o classificador faz `nak`
  (retry), não `term`. Só é problema se um job for **terminado** (`✗`) por causa disto (perda de job).
- **`fetch` com centenas de milhar de pendentes** — é o backfill base-wide em curso (~1 dia). Normal.
