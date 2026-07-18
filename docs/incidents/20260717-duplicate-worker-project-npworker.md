# Incidente: containers worker DUPLICADOS — projeto compose `worker` → `npworker` sem teardown do antigo

- **Estado:** CLOSED (confirmado pelo monitor @2026-07-17T16:21Z)
- **Primeiro visto:** 2026-07-17T15:27Z (ronda do monitor)
- **Área:** Auto-deploy PULL (watchlist DEBUGGING-TODO: *"recreate em loop, ou containers duplicados"*)
- **Hosts afetados:** np-wk-de1 (impactante), oracle-e2-1, oracle-e2-2 (benigno) — todos os git-hosts
- **NÃO afeta:** hel1-docker (SKIP_GIT, restart manual), gpedro-laptop (auto-deploy Windows Task, mecanismo diferente)

## Sintoma

O deploy PULL recente **renomeou o projeto compose** de `worker` para `npworker` (mudança de
`COMPOSE_PROJECT_NAME`/diretório no `pull-deploy.sh`), mas o `docker compose up` do projeto novo
**não derrubou o projeto antigo**. Resultado: cada git-host corre **DOIS** containers worker em
paralelo — o antigo `worker-worker-1` (rede `worker_default`) + o novo `npworker-worker-1`
(rede `npworker_default`).

Snapshot @15:27Z (via `/api/workers` → `hosts.<host>.containers`):

| Host | container ANTIGO (projeto `worker`) | container NOVO (projeto `npworker`) | load / cores | Impacto |
|---|---|---|---|---|
| **np-wk-de1** | `beaf4a784ce5` worker-worker-1 **Up 18m, CPU 128%** | `3b568d9caef4` npworker-worker-1 **Up 15m, CPU 470%** | **15.61 / 6** (~600% CPU) | **ALTO** — ambos processam lighthouse; VM saturada |
| oracle-e2-1 | `963a727eb5db` worker-worker-1 Up 48m, CPU 0.04% (idle) | `5fe3aaebe584` npworker-worker-1 Up 6s, CPU 74% | 0.58 / 2 | baixo (base idle) |
| oracle-e2-2 | `e4a5099fdf20` worker-worker-1 Up 45m, CPU 0.23% | `af5d0f04a7f7` npworker-worker-1 Up 20m, CPU 0.36% | 0.02 / 2 | baixo (base idle) |

Não é o "drain overlap `--no-deps`" esperado (que dura <1 ronda): os containers ANTIGOS estão
**Up 45-48 min** e a coexistir de forma persistente com os novos — dois projetos compose vivos ao
mesmo tempo, não um a drenar.

## Evidência (log do docker de1, descodificado de `hosts.np-wk-de1.containers[svc:docker].logb64`)

```
14:28:32 healthcheck failed fatally ... "only one connection allowed"   (worker-worker-1)
14:43:27 restarting container beaf4a784ce5 exitCode=1 restartCount=1 restartPolicy=unless-stopped
14:59:41 restarting container beaf4a784ce5 exitCode=1 restartCount=2
15:01:55 stopping restart-manager container aa80a6521503   (worker antigo do baseline 14:23 removido)
15:01:58 sbJoin ... ep=npworker-worker-1 net=npworker_default   (projeto NOVO npworker arranca AQUI)
```

Ou seja: às 15:01:58 o projeto `npworker` foi criado; o projeto `worker` (container
`beaf4a784ce5`) **não foi derrubado** e ficou a correr (chegou a restart-loopar exitCode=1 ×2
entre 14:43 e 14:59; desde ~14:59 está Up 18m sem novo restart — o loop assentou, mas o container
duplicado persiste).

## Impacto

1. **de1 CPU saturado** — load 15.61 em 6 cores; dois workers `browser` a puxar lighthouse do mesmo
   backlog do sweep >55. Contenção de Chrome aumenta → de1 aborta lighthouse (`desisto após 3`:
   taxi-examen.nl, rubybrands.nl no log do container) — mas a taxa fleet-wide de abortos mantém-se
   modesta (~10 ✗/24min = ~10× ABAIXO do pico de referência R9 105/25m), por isso **NÃO é o pico
   lighthouse** que justificaria recuar do teto 20. O desperdício é de CPU/duplicação, não perda em massa.
2. **Buraco de observabilidade em de1** — o dashboard mostra `np-wk-de1.workers: []` (0 beats
   registados) apesar dos 2 containers estarem vivos e a processar (provado pelos `logb64`). de1
   emite **0 linhas** em `/api/logs`. Os beats/logs de de1 não chegam ao sink Redis do np-server
   (a NATS chega — daí processarem jobs). Consequência: os abortos lighthouse REAIS de de1 estão
   escondidos da vista da frota → a contagem fleet-wide de ✗ lighthouse está subestimada.
   (Nota tailscaled de1: `flow TCP ... => 100.124.43.117:9000 got RST by peer` + DNS refusals —
   possível causa da falha de registo de beats.)
3. **oracle-e2-1/2** — duplicação também presente mas benigna (role base idle, 2 cores, load ~0);
   o container antigo está idle porque o novo npworker ganhou a subscrição. Sem dano, mas é lixo a limpar.

## Causa provável

`deploy/agent/pull-deploy.sh` passou a usar um nome de projeto/diretório novo (`npworker`) sem
executar `docker compose -p worker down` (ou `--remove-orphans` no projeto antigo) antes de subir o
novo. Como o `restartPolicy` do antigo é `unless-stopped`, ele sobrevive ao deploy e continua a
consumir da mesma durable NATS.

## Ação do monitor

- **NÃO corrigido pelo monitor** — derrubar containers exige SSH ao host / `docker compose down`,
  fora do âmbito autorizado (o monitor só opera FILAS + mantém docs). **Flagged na conversa.**
- **Filas:** nenhuma ação — os órfãos desta ronda são só de filas de sweep (gmb 8, lighthouse_desktop
  12, lighthouse_mobile 19), que não se relançam. Nenhuma fila não-sweep tem órfãos.

## Recomendação ao utilizador

1. **de1 (urgente):** derrubar o projeto antigo — `docker compose -p worker down` (ou
   `docker rm -f beaf4a784ce5`) para ficar só o `npworker`. Alivia o load 15.6 → ~metade e reduz a
   contenção de Chrome/abortos lighthouse.
2. **oracle-e2-1/2:** o mesmo `docker compose -p worker down` (baixo risco, benigno mas limpa lixo).
3. **Corrigir `pull-deploy.sh`:** ao mudar o nome do projeto, derrubar o projeto antigo primeiro
   (`docker compose -p <antigo> down --remove-orphans`) — senão cada rename futuro duplica a frota.
4. **de1 observabilidade:** investigar porque os beats/logs de de1 não chegam ao Redis do np-server
   (RST em `:9000` na tailnet) — de1 está a trabalhar às cegas para o dashboard.

## Observações datadas

- **2026-07-17T15:27Z (R1, deteção):** 2 containers worker+npworker em de1/oracle-e2-1/oracle-e2-2;
  de1 load 15.61 (~600% CPU), `workers:[]` no dashboard, 0 linhas em `/api/logs`. Antigo de1
  restart-loopou exitCode=1 ×2 (14:43/14:59) e assentou. Sweep lighthouse a drenar (desktop pend
  5535, mobile 2999). Abortos fleet-wide ~10/24min (NÃO pico). Sob observação.

## Update 2026-07-17T15:3xZ (main / operador)

- **de1 caiu da tailnet:** `tailscale status` → `np-wk-de1 100.120.214.45 offline, last seen 12m ago`.
  A sobrecarga dos 2 workers a fazer lighthouse (load 15.61 / 6 cores) terá bloqueado/derrubado a VM.
  Confirma o `workers:[]` + 0 linhas em `/api/logs` para o de1 no snapshot do monitor.
- **Fix de causa-raiz aplicado (commit b1d6cf9):** `deploy/agent/pull-deploy.sh` passo 0 — derruba qualquer
  projeto compose ≠ COMPOSE_PROJECT com serviço `worker`. **Auto-limpa:**
  - **oracle-e2-1/2**: no próximo ciclo do agente (~5 min) — sem ação manual.
  - **de1**: quando VOLTAR (boot → git-pull → agente → cleanup). RISCO: no boot os containers antigos
    (`restart: unless-stopped`) autoarrancam ANTES do timer do agente (5 min) → janela curta de re-overload.
- **AÇÃO PENDENTE (fora do âmbito do agente):** **power-cycle do de1** (VM no `de1-pve` 100.87.226.117) para
  voltar. Assim que arranque + o agente corra 1 ciclo, o projeto `worker` órfão é derrubado e fica só o
  `npworker`. Se re-overloadar antes disso, parar o projeto antigo à mão: `docker compose -p worker down`.
- **Estado:** fix de recorrência FECHADO; recuperação do de1 PENDENTE (power-cycle).

## RESOLVIDO 2026-07-17T15:5xZ (main / operador, autorizado pelo user)

- **de1 recuperado.** A VM (`de1-pve` VMID **800**) estava **`stopped`** (não hung — parou sob overload).
  Sequência: `qm start 800` → esperar guest-agent → `qm guest exec 800 -- docker rm -f` dos containers do
  projeto `worker` órfão (antes de re-sobrecarregar) → sobra só `npworker-worker-1`.
- **Estado final do de1:** load **0.42** (era 15.61), **1 worker** (`npworker-worker-1`), a processar normal.
- **oracle-e2-1/2:** dupes benignos (base idle) — auto-limpam no próximo ciclo do agente (git-pull do
  b1d6cf9 → passo 0 derruba o projeto `worker`). Sem ação manual.
- **Recorrência:** prevenida pelo commit b1d6cf9 (pull-deploy.sh passo 0). **Incidente FECHADO.**

## Confirmação do monitor 2026-07-17T16:21Z (mantém-se FECHADO)

- **de1 = 1 worker único, saudável:** `/api/workers` mostra 1 só container em `np-wk-de1`
  (`ecae4845abeb`, role `security,browser`, up **12.9m**, beatAge **5s**, load **1.54 / 6 cores**,
  fail1h 16, done1h 23, ver `gmb-strict-v7`). Load caiu de 15.61 → **1.54** (~10×). SEM 2º conjunto.
- **Buraco de observabilidade de de1 FECHADO também:** de1 voltou a **reportar beats** ao dashboard
  (beatAge 5s, fail1h/24h visíveis; era `workers:[]` + 0 linhas durante o incidente). Os abortos de de1
  já não estão escondidos.
- **oracle-e2-2 = 1 worker** ✓ (`cb17048168f6`, up 11.7m, beatAge 3s, base idle). Auto-limpou.
- **oracle-e2-1 = 2 workers MAS é drain de recreate, NÃO regressão:** `2cf7f24f0512` (up 9.7m, beatAge
  **80s** — a envelhecer/drenar, load 0.01) + `84fce50c1865` (up **0.9m**, beatAge 4s, fresco). O antigo
  parou de bater há ~80s → é o overlap `--no-deps` de um recreate por git-pull (HEAD avançou
  `8f5942e`→`2cd98e8`, 5 commits incl. este fix b1d6cf9; env-hash inalterado = code). NÃO é o padrão do
  incidente (2 containers persistentes Up 45-48m ambos a bater e a processar) — aqui o antigo está a
  drenar. Deve cair no próximo ciclo. **VIGIAR 1 ronda** que resolve para 1.
- **Git confirma o fix implantado:** `b1d6cf9` "fix(auto-deploy): derrubar projeto compose órfão
  (worker→npworker duplicava workers → overload)" está no histórico e propagou-se aos git-hosts (que
  recriaram). O rename de projeto já não deixa o antigo vivo.
- **Veredicto:** incidente **mantém-se FECHADO**; recorrência prevenida (b1d6cf9), de1 recuperado e a
  reportar, dupes benignos auto-limpos. Único resíduo = drain de recreate transitório em oracle-e2-1.
