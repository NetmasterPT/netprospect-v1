# Plan: Fix do indicador geral + otimização da frota (resize/consolidação) + migração da observabilidade para a stack Prometheus/Grafana/Alertmanager

## Context

Três frentes pedidas pelo utilizador, todas com dados reais recolhidos:

1. **Bug do indicador GERAL de load por Servidor/DC.** Os cards por-VM estão certos, mas a barra agregada
   do DC dá >100% (HEL1 = 190%). Causa: um **LXC não-privilegiado lê o `/proc/loadavg` do NÓ FÍSICO** →
   todos os ~19 guests reportam ~o mesmo load; `dynLoad` soma-os. É só dashboard.

2. **Frota assimétrica.** `hel1-pve` folgadíssimo (36c/314 GiB, **126 GiB livres**, load 61%) vs `de1-pve`
   espremido (**8c/31 GiB**, overcommit RAM **2.3×**, **swap 82%**). Consequências reais: `np-server` a
   **99% RAM (8/8 GB)** → os "Directus under pressure/503"; `np-wk-de1` a **48% de falhas** (browser/
   lighthouse a expirar) por contenção de CPU/RAM+swap com ClickHouse/MinIO nos 8 cores do de1.

3. **Migrar a observabilidade** do agente Claude (que hoje faz tudo por `curl`/NATS a cada 15 min) para a
   **stack já instalada** (Prometheus+Grafana+Alertmanager+ntfy+blackbox+uptime-kuma, CTs no hel1-pve). O
   agente passa a **CONSULTAR** o Alertmanager/Prometheus (fontes de verdade) e a focar-se em raciocínio +
   operação (deploy-watch, poison, requeue de órfãos). **Muito já foi feito hoje** — falta completar o gap.

Estado da infra (verificado): Proxmox **standalone** (não-cluster); `hel1-docker`=10.10.10.50/24 no `vmbr1`
(mesmo L2 que a futura VM 509=10.10.10.59 → o IP interno funciona); PBS partilhado `pbs-de` acessível dos
2 nós; storage `local-zfs` no hel1-pve.

---

## Workstream A — Fix do indicador geral (dashboard, rápido, baixo risco)

**Ficheiro:** `dashboard/public/index.html` (só). **Sem backend/agente.** Reutiliza o `pveOf`/`pve` que já
existe em ambos os sítios.

Regra: **load do DC = load do nó `-pve`** (que já agrega todos os guests) **+ workers cloud standalone**
(DCs sem `-pve`: Oracle/Laptop). **Nunca somar os guests de um `-pve`.** Não há campo node-vs-guest → inferir
pelo nome `/-pve$/` (já usado).

- `dynLoad` (**index.html:1635**): passar a — se `pveOf(list)` existe → `loadBar(pve.load, pve.cores)`; senão
  → o `Σload/Σcores` atual (hosts independentes). (Para rigor: excluir guests do `-pve`; a versão mínima
  segura é usar só o `-pve` quando existe.)
- `openServer` `totLoad`/`totCores` (**index.html:1697**, render em **:1712**): mesma regra, reutilizando o
  `pve` já computado em **:1709**.
- Deixar as barras por-VM (`loadBar(v.load, v.cores)`) como estão — o utilizador confirmou que parecem
  certas; o problema é só o agregado. (Nota lateral: os cards LXC individuais também estão inflados na
  origem, mas isso é secundário e não pedido.)

Deploy: rebuild do dashboard no np-server (pull agent). Valores esperados: HEL1 ≈ 49%, DE1 ≈ 84%→(após B)
mais baixo, Laptop ≈ 73%, Oracle ≈ 4%.

---

## Workstream B — Resize / consolidação da frota (Proxmox + env)

Ops **read-write** de Proxmox (executar após aprovação). SSH: hel1-pve `root@100.86.211.70`, de1-pve
`root@100.87.226.117`. Ordem pensada para aliviar o de1-pve o mais cedo possível.

### B1 (prio 1) — np-server RAM 8→16 GB  *(hel1-pve, VM 801)*
- `qm set 801 --memory 16384` → `qm reboot 801` (RAM não é hot-plug aqui sem config; reboot curto).
- hel1-pve tem 126 GiB livres → sem risco. **Mata os 503 "Directus under pressure".**

### B2 (prio 2) — APAGAR factory-germany  *(de1-pve, VM 900, idle 0.31/16 GB, não-NP)*
- `qm stop 900` → `qm destroy 900 --destroy-unreferenced-disks 1 --purge 1` (apaga VM **e disco**, como pedido).
- Liberta **16 GB** imediatos no de1 (31 GB físicos) → alivia o swap.

### B5 (prio 5) — Migrar de-analytics (ClickHouse) de1→hel1  *(VM 301 → VM 509, IP 10.10.10.59)*
Feito ANTES do B3 porque é o maior alívio do de1 (tira 16 GB + 6 vCPU). ClickHouse é **fail-soft** (downtime
curto não parte a pipeline; só se perde a escrita de observações durante a janela — `lib/metrics.js:3`,
`worker/handlers.mjs:333`). Como NÃO são cluster e o data-dir é migrável:
1. **de1-pve:** parar o container CH na VM 301; `vzdump 301 --storage pbs-de` (ou rsync de `/srv/analytics/
   clickhouse`). *(Alternativa: fresh VM + rsync do data-dir — decidir na execução; recomendado vzdump→PBS
   por preservar a VM exatamente.)*
2. **hel1-pve:** `qmrestore` do backup de pbs-de → **VM 509**; ajustar rede para `vmbr1` IP **10.10.10.59/24**
   gw 10.10.10.1; entrar na tailnet (novo IP tailscale — opcional, só para gestão).
3. **VM 509:** em `deploy/analytics/.env` pôr o **bind do ClickHouse em 10.10.10.59** (a compose usa
   `${TAILNET_IP}:8123:8123` em `deploy/analytics/docker-compose.yml:29` → definir `TAILNET_IP=10.10.10.59`
   ou bind `0.0.0.0`), credenciais iguais às do HEL1; `docker compose up -d clickhouse`. Data-dir já vem no restore.
4. **Atualizar o único consumidor (hel1-docker):** `CLICKHOUSE_URL=http://10.10.10.59:8123` em **`docker/.env:53`**
   **E** no store da frota host `hel1-docker` (`PUT /api/fleet/env/hel1-docker`). Depois recriar `dashboard`,
   `worker`, `worker-base` (apanham a env). Corrigir o comentário stale em `docker/.env:49-50`.
   - **Nenhum outro host tem `CLICKHOUSE_*`** (np-wk-de1/oracle/laptop não escrevem no CH — confirmado). O IP
     interno serve porque só o hel1-docker (10.10.10.50) consome e está no mesmo `vmbr1`.
5. **Validar** (ver Verificação) → só então `qm destroy 301 --purge 1` no de1-pve (liberta 16 GB + 6 vCPU).

### B3 (prio 3) — np-wk-de1 RAM 24→12 GB  *(de1-pve, VM 800; usa 8, reserva 24)*
- `qm set 800 --memory 12288` → `qm reboot 800`. (Após B2+B5, o de1-pve já está folgado; isto consolida.)

### B4 (prio 4) — as 48% de falhas do np-wk-de1  *(a minha recomendação)*
- **Resolve-se sobretudo com B2+B5+B3**: as falhas vêm de contenção de CPU/RAM+swap no de1-pve (worker
  competia com ClickHouse+MinIO+factory nos 8 cores/31 GB). Sem o factory (B2) + sem o ClickHouse (B5) +
  reserva menor (B3), o de1-pve deixa de fazer swap e o worker ganha CPU.
- **Depois:** monitorizar `fail1h` do np-wk-de1 ~2-3 rondas. Se ainda alto (browser/lighthouse a expirar em 6
  cores): descer `LIGHTHOUSE_CONC` do de1 (2→1) e/ou tirar-lhe o role `browser` (concentrar lighthouse no
  hel1+laptop, que têm folga) via o store de `.env`. O recomendador `/api/autoscale` guia o ajuste fino.

### B6 (prio 6) — mais carga nos Oracles (2× e2-micro, 2c/954 MB)  *(a minha recomendação)*
- Limitados por RAM (browser/lighthouse ~550 MB e nuclei 250/wpscan 450 MB são arriscados em 954 MB). Já
  fazem base (network-light). Recomendo: **adicionar o role `verify`** (rede/API, leve, ~0 RAM) para
  descarregar o verify do hel1 — respeita a quota global, mas distribui o trabalho leve. Opcional/arriscado:
  `security` com `NUCLEI_JOB_CONC=1` + `WPSCAN_CONC=0` (só nuclei, 1 de cada vez), **a vigiar OOM**. Aplica-se
  pelo store de `.env` dos oracles. Ganho modesto — os oracles são estruturalmente pequenos.

---

## Workstream C — Observabilidade: completar a stack + o agente passar a consultá-la

Já existente (CTs em hel1-pve, feito hoje): **Prometheus** (CT200, já raspa `netprospect`→`/metrics`),
**8 regras** host (`/etc/prometheus/rules/netprospect.yml`), **Alertmanager** (CT203)→**ntfy** (CT205) via o
webhook já existente `dashboard/server.mjs:2028` (`POST /api/alertmanager-webhook`), **Grafana** (CT201,
datasource Prometheus uid `cfaqq4y8u03k0e`), **blackbox** (CT204), **uptime-kuma** (CT301, vazio),
**pve-exporter** nos 2 nós. **Tracing OTEL→Jaeger** existe (`worker/tracing.mjs`, `dashboard/tracing.mjs`,
`OTEL_ENABLED`). App `/metrics` em `dashboard/server.mjs:2051` expõe `np_host_*`/`np_workers_up`.

### C1 (ENABLER) — Métricas por-fila/consumer no `/metrics`  *(dashboard/server.mjs)*
Hoje o `/metrics` só tem host+workers; **as verificações do monitor são quase todas sobre FILAS**. Adicionar
gauges por consumer, com os mesmos dados que o `/api/queues` já calcula (NATS `consumers.info` + Redis +
`addQueueCapacity`):
`np_queue_pending{consumer}`, `np_queue_ack_pending{consumer}`, `np_queue_orphans{consumer}`,
`np_queue_redelivered{consumer}`, `np_queue_max_ack{consumer}`, `np_consumer_jobs_done_1h{consumer}`,
`np_consumer_fail_1h{consumer}`, `np_consumer_avg_ms{consumer}`. Fatorar/chamar a lógica de `/api/queues` no
handler de `/metrics` (já corre a cada scrape de 30s). **Sem isto, nenhuma regra de fila tem base.**

### C2 — Regras Alertmanager para as verificações do monitor  *(pct exec 200 → /etc/prometheus/rules/netprospect.yml)*
Mapear cada item do `DEBUGGING-TODO.md` a uma regra (juntar às 8 já existentes):
- **Fila sem worker a puxar:** `np_queue_pending>200 and np_queue_ack_pending==0` for 15m (por consumer,
  excluir `fetch`/sweep via label ou threshold).
- **Órfãos:** `np_queue_orphans{consumer!~"fetch"} > 0` for 15m (o requeue continua a ser AÇÃO do agente).
- **Pico de falhas por consumer:** `np_consumer_fail_1h / (np_consumer_jobs_done_1h+1) > 0.2` for 20m.
- **Swap alto (de1):** `np_host_swap_used_bytes/np_host_swap_total_bytes > 0.5` for 10m.  **[NOVO — o gap que
  causou o incidente do de1]**
- **Directus 503 / latência:** já existe (`np_host_latency_ms{target=directus}>500`).
- **Worker/host down, RAM/CPU/disco:** já existem.
- **Esperado → `inhibit`/silence** no `alertmanager.yml`: quota do verify, gmb lento no laptop, Directus
  under-pressure transitório, backlog do `fetch`/sweep. (Ficam como contexto do agente, não alertam.)
- Deploy-watch e "containers duplicados" ficam **no agente** (raciocínio temporal difícil de exprimir em
  PromQL); opcional: `np_host_workers > <esperado>` como sinal grosseiro de duplicados.

### C3 — Reconciliar o datasource do Grafana
O dashboard provisionado `netprospect.json` referencia `uid:"netprospect-fleet"` mas o datasource real tem
uid `cfaqq4y8u03k0e` → painéis não bindam. **Provisionar** um datasource Prometheus com uid fixo
`netprospect-fleet` em `/etc/grafana/provisioning/datasources/` (hoje só tem `sample.yaml` comentado), OU
reescrever o `netprospect.json` para o uid real. Provisionar é o correto (idempotente).

### C4 — Cobrir o nó de1 no Prometheus
Adicionar o target `prometheus-pve-exporter.de1` (`100.87.226.117`-side IP:9221) ao job `proxmox` do
`prometheus.yml` (hoje só tem 1 target hel1).

### C5 — Exporters em falta (canónicos)  *(novos CTs/containers, a decidir profundidade)*
- **nats/JetStream exporter** (lag de consumidores, fonte canónica de filas — complementa o C1).
- **postgres_exporter** (np-db, write-path pesado; hoje só o proxy `np_host_latency_ms{target=postgres}`).
- **redis_exporter** (np-server Redis).
- **node-exporter** nos guests (np-server, hel1-docker, np-wk-de1, de-analytics→509, de-minio) para métricas
  de OS canónicas por-guest (o `np_host_*` vem de um agente próprio, não é node-exporter).
- **cAdvisor** nos hosts Docker (hel1-docker, np-wk-de1) para CPU/mem por-container.
- Adicionar cada um como job no `prometheus.yml`.
  *(Faseável: C1+C2+C3+C4 dão o essencial; C5 é profundidade/cobertura máxima.)*

### C6 — Uptime-Kuma
Hoje **vazio**. Decidir: usá-lo para uptime externo dos serviços NP (dashboard, Directus, MinIO, NATS,
ClickHouse-509) com checks HTTP/TCP + notificação ntfy; OU deixar ao blackbox-exporter e não duplicar.
Recomendo popular o Uptime-Kuma com os 5 endpoints (visão "está vivo?" simples, independente do Prometheus).

### C7 — Refactor do monitor Claude: CONSULTAR em vez de fazer tudo
- O loop de 15 min passa a: **1)** `GET` alertas ativos do Alertmanager (via API `…:9093/api/v2/alerts` ou um
  endpoint proxy na app) → é a deteção; **2)** só consulta o Prometheus/`/api/queues` para detalhe quando um
  alerta dispara; **3)** mantém as AÇÕES que não são exprimíveis em regras: requeue de órfãos seguros,
  deploy-watch (baseline/observação), decisões de poison, e o raciocínio de "isto é esperado?".
- **Atualizar** `DEBUGGING-TODO.md` (fonte-de-verdade = Alertmanager/Prometheus; lista o que é regra vs o que
  fica no agente) e o **prompt do monitor** (cron `6dfdc3fa`) para o novo fluxo. O agente deixa de fazer os
  `curl /api/queues|workers|logs` exaustivos por defeito e passa a agir sobre alertas.
- Resultado: deteção sempre-on/instantânea (Alertmanager), menos tokens, e o Claude focado em julgamento +
  operação. A stack observa; o Claude decide e opera.

---

## Sequência & dependências

1. **A** (fix dynLoad) — independente, primeiro (valor imediato).
2. **B1** (np-server 16 GB) — independente, alto valor (mata 503).
3. **B2** (apagar factory-germany) → **B5** (migrar ClickHouse, validar, destruir VM 301) → **B3** (np-wk-de1
   12 GB) → **B4** (observar falhas do de1; ajustar se preciso). Ordem alivia o de1-pve cedo.
4. **C1**→**C2**→**C7** (o caminho crítico da observabilidade: métricas de fila → regras → agente consulta).
   **C3/C4/C6** em paralelo; **C5** faseável a seguir.

---

## Verificação

- **A:** rebuild do dashboard; página Servidores → barra do HEL1 ≈ 49% (não 190%), DE1/Laptop/Oracle coerentes;
  abrir drawer do servidor → mesmo valor.
- **B1:** `qm config 801` → memory 16384; np-server RAM deixa de estar a 99%; cessam os 503 "under pressure".
- **B2:** `qm list` no de1 sem 900; `free -h` no de1-pve com swap a descer.
- **B5:** dashboard `status.clickhouse.up==true` (via `/api/...` status); timeline/gatilhos voltam a ter dados;
  um job real → `recordRun` escreve (contar linhas em `netprospect.observations` no CH novo);
  `curl http://10.10.10.59:8123/ping` do hel1-docker = `Ok`. Só então destruir a VM 301. de1-pve com +16 GB +6 vCPU.
- **B3:** `qm config 800` → memory 12288; de1-pve sem swap; np-wk-de1 estável.
- **B4:** `fail1h` do np-wk-de1 a cair para níveis normais (não ~48%).
- **C1:** `curl http://100.114.17.74:3001/metrics | grep np_queue_` → séries por consumer com valores que batem
  com `/api/queues`.
- **C2:** `promtool check rules` OK; forçar uma condição (ex.: um consumer com órfãos) → alerta aparece em
  `…:9093/api/v2/alerts` e chega ao ntfy.
- **C3:** abrir o dashboard "NetProspect" no Grafana → painéis com dados (datasource bindado).
- **C7:** uma ronda do monitor consome os alertas do Alertmanager (não os `curl` exaustivos) e só age sobre eles.

---

## Notas / risco

- **Irreversíveis:** B2 (apagar factory-germany+disco) e B5-passo-5 (destruir VM 301) — o utilizador pediu
  explicitamente B2; para B5 só destruir a 301 **após validar** a 509. Snapshot/backup antes das ops de RAM
  (B1/B3) é trivial e recomendado.
- **Downtime aceite:** curto do ClickHouse durante B5 (fail-soft; perde-se só escrita de observações na janela).
- **IP interno vs tailnet (ClickHouse):** `10.10.10.59:8123` validado (hel1-docker no mesmo `vmbr1`); se um dia
  os workers de de1/oracle/laptop precisarem de escrever no CH, mudar para o IP tailscale da 509.
- **Deploy da app:** A e C1 = só rebuild do dashboard (np-server); C7 = docs + prompt do cron; B = Proxmox+env.
- **Observabilidade já 60% feita hoje** — C é sobretudo completar (métricas de fila, regras, uid do Grafana,
  exporters) e o refactor do agente, não construir de raiz.
