# Deploy-watch — deteção de rebuilds + observação pós-deploy por VM

O monitor de saúde (loop de 15 min) usa este ficheiro para **detetar quando um host recebeu um deploy**
(o agente de pull local fez `git pull` / mudou o `.env` / recriou os containers) e para **vigiar ativamente
essa VM durante uma janela** a seguir à mudança — a testar o resultado (logs, load, throughput, falhas,
consumers/roles) e a confirmar que não regrediu. Genérico sobre QUALQUER host que apareça em
`/api/workers` ou `/api/fleet/env` — inclui os futuros `de-minio`, `de-analytics`, `np-server`, `np-db`
quando entrarem no dashboard como VMs.

Ver a instrução em [`../DEBUGGING-TODO.md`](../DEBUGGING-TODO.md) → "Deploy-watch (AÇÃO a cada ronda)".

## Como o monitor deteta um deploy (sinais centrais, sem SSH a cada host)

Por host, comparar o snapshot desta ronda com a **baseline** (tabela abaixo, escrita na ronda anterior):

1. **`started` recuou / uptime caiu** — se o `started` (epoch) de um worker mudou, ou o uptime é *menor* do
   que o esperado (`uptime_baseline + minutos_decorridos`), houve **RECREATE** desde a última ronda. É o
   sinal à prova de bala (git pull OU mudança de .env → o container reinicia → `started` reset).
2. **`version` mudou** — imagem/label de build novo (ex.: `up --build` no np-server). Rebuild de imagem.
3. **hash do `/api/fleet/env/<host>` mudou** vs baseline — o `.env` central mudou → deploy **a caminho** no
   próximo ciclo do agente desse host (arma a observação: espera-se um recreate em breve).
4. **conjunto de `consumers` mudou** — os roles efetivos mudaram (confirma que o novo `WORKER_ROLES` pegou).

## O que fazer ao detetar um deploy

- Pôr o host **sob observação** por **K = 3 rondas (~45 min)**. Guardar a **baseline pré-deploy**
  (fail1h/fail24h, done1h, load, consumers) para comparar.
- Durante a observação, **validar ativamente** a cada ronda:
  - **Volta e estabiliza:** `beat < 90s` e uptime a **crescer** (não a resetar de novo cada ronda =
    crash-loop). Uptime a resetar 2 rondas seguidas → **REGRESSÃO** (arranque a falhar).
  - **Roles certos:** os `consumers` batem com o `WORKER_ROLES` esperado da mudança.
  - **Sem pico de falhas:** `fail1h`/`fail24h` não dispara vs a baseline pré-deploy (>2× ou taxa >5% e a subir).
  - **Load/CPU são:** load por core plausível, não encravado.
  - **Logs limpos:** `/api/logs` sem `✗`/stack-trace/`Cannot find`/`SyntaxError` NOVOS logo após o restart
    (churn isolado de `CONNECTION_DRAINING`/`↻ fetch` no instante do recreate é esperado, não conta).
  - **Throughput recupera:** `done1h` a subir (a menos que a fila esteja legitimamente vazia).
- **Veredicto:** saudável K rondas → **VALIDADO**, sai da observação (linha movida para o histórico ou
  removida). Regressão → **abrir incidente** (`docs/incidents/<data>-<slug>.md` + linha no `DEBUG-FOUND.md`)
  e **reportar na conversa**.
- No fim da ronda, **reescrever a baseline** abaixo com os valores desta ronda (para a próxima diferença).

---

## Baseline por host (reescrita a cada ronda)

_Snapshot @ 2026-07-18 ~09:21Z. O monitor recalcula e reescreve estes valores a cada ronda a partir de
`/api/workers` + `/api/fleet/env/<host>`. **env-hash = `sha256sum | cut -c1-16` do corpo de
`/api/fleet/env/<host>`** (método fixado @11:20). uptime a `(beat-started)/1000`. done1h é contador de
hora-de-relógio (valores variáveis normais)._

**✅ EVENTO DA RONDA @09:21Z — SEM deploy novo (env-hashes 5/5 INALTERADOS); migração CH R2/3 estável:**
`/api/alerts` **count=0** (frota saudável nas dimensões de regras) e **`/api/config` clickhouse.up=TRUE**. **Nenhuma mudança de `.env`**
(hashes 5/5 iguais a @08:22). Os recreates de **de1/oracle1/oracle2** (ids novos, env inalt., version inalt.) = **code pull** (git);
**laptop** reciclou (churn residencial; era `0ed5dbc3cb68` → `32a823fc3f73`). **10 workers (1/host + hel1 6, sem duplicados).**
**hel1 base ×3 CONTÍNUO** (mesmos ids `3de203d3`/`ff9f8dfad7`/`04630ff6`, up 20.4m@08:22 → **81.1m** = +60.7m 1:1, **sem recreate**);
**hel1 ai ×3 reciclaram 1×** (mesmos ids `ab7a34f9`/`2f1f24be`/`964d368a`, uptime reset 20.3m → **6.8m**, MAS **fail1h 0/0/0** = melhor
estado, load 1.36/18 são, uptimes agora a crescer → **não crash-loop**, reciclagem residual documentada, sem perda).

**✅ Migração CH VALIDADA R2/3 (hel1-docker + np-server sob observação K=3):** `campaign_generate` **0/0/0 não-órfão** servido pelos 3 ai
(waiting 3); **roles corretos** (3 base `[base]`+campaign_send · 3 `[browser,security,ai,verify]`+campaign_generate); **0 crash/SyntaxError/
erro-CH** nos logs; np-server dashboard responde a todos os endpoints + **clickhouse.up=TRUE**. **Ressalva mantém-se (a confirmar em R3/3):**
write-path CH (lighthouse→CH) **AINDA por exercitar sob carga** — lighthouse pend 0, os 3 ai idle (done1h 0). Confirmar num próximo lote
lighthouse que os ai gravam no CH novo sem erro.

**⚠️ PG em `subdomains`/hel1+laptop — ASSINATURA MUDOU `ETIMEDOUT`→`ECONNREFUSED 91.199.212.73:5432` (14 ECONNREFUSED + 12 ETIMEDOUT = 26
no buffer, ↓ vs 59 @08:22):** alvo = **CT Postgres/PgBouncer** (NÃO é ClickHouse — CH é 100.120.43.49:8123; migração não tocou o PG).
ECONNREFUSED = PgBouncer/PG a **RECUSAR** ligações (pool/max_client_conn cheio sob subdomains maxAck 16), variação da mesma saturação de
escrita do sweep crt.sh. **Confinado a 1 job** (só subdomains — 0 spread a enrich/score/whois/geoip, todas 0/0/0), **retry-only** (73 ↻ +
14 ✗ todas subdomains; sem term/perda além do best-effort do sweep), hel1(12)+laptop(14). Explica INTEIRAMENTE base fail1h 232/128/3 (hel1)
+ 8 (oracle1), com under-pressure 0. **Nenhum dos 2 gatilhos de escalada (@08:22: "espalhar a outros jobs" OU "subir claramente mais")
ATINGIDO** (não espalhou; raw 26<59) → observação datada, **NÃO incidente**. Novo gatilho: ECONNREFUSED a persistir/crescer OU o refuse do
PgBouncer a atingir OUTROS jobs de escrita PG → abrir incidente.

**✅ HostOverloaded LXC continua LIMPO / Directus saudável / gmb sem bloqueios / C5 estável:** `/api/alerts` count=**0** (0 `NetProspect
HostOverloaded`, regra `np_host_cores>=4`; inclui os targets nats/redis/postgres do C5/CT200 → nenhum a disparar). Logs: **0 under-pressure/
503**, **0 bloqueios gmb** (/sorry//recaptcha/blocked), **0 crash/SyntaxError**, **0 erros ClickHouse**. C5 exporters np-server estável
(dashboard responde, sem alertas de target down).

_Fleet fail1h @09:21 (fresco, beatAge <10s): hel1 base **128-232** (`04630ff6`=232 / `3de203d3`=128 / `ff9f8dfad7`=3) = só **PG erros
subdomains** (ECONNREFUSED+ETIMEDOUT, retry-only, under-pressure 0) · ai **0/0/0** · de1 0 · laptop 30 (subdomains PG) · oracle1 8 · oracle2 0.
**0 crash/SyntaxError**, **0 erro-CH**, **0 bloqueios gmb**, **0 under-pressure/503**._

| Host | uptime(min) | version | env-hash | fail1h | fail24h | done1h | load | roles efetivos (via consumers) |
|---|---|---|---|---|---|---|---|---|
| np-wk-de1 | 3.2 (id `1171ca2d708e`, beat 0.0s) — **RECREATE (code pull, env inalt.); 1 worker** (era `818202443a8e`) | gmb-strict-v7 | `3d3b8279f8adc2a3` | 0 | 0 | 0 | **0.02 / 6** | security, browser (lh maxAck 20, nuclei/wpscan) |
| gpedro-laptop | 9.1 (id `32a823fc3f73`, beat 7.9s) — recreate (churn residencial; era `0ed5dbc3cb68`) | gmb-strict-v7 | `ac092458db68651b` | 30 | 30 | 15 | 0.08 / 22 | residential, security, base, browser (gmb maxAck 5, lh maxAck 20) — fail1h=subdomains PG |
| oracle-e2-1 | 5.7 (id `c146b24baf71`, beat 0.3s) — recreate (code pull, env inalt.; era `9aaaa079dfe1`) | gmb-strict-v7 | `f8c003a232714fbe` | 8 | 8 | 3 | 0.08 / 2 | base (sem campaign_generate) — fail1h=subdomains PG |
| oracle-e2-2 | 1.9 (id `d41c1a2fa08d`, beat 9.5s) — recreate (code pull, env inalt.; era `b4cf61724487`) | gmb-strict-v7 | `92cd92b1e3761d6d` | 0 | 0 | 3 | 0.25 / 2 | base (sem campaign_generate) |
| hel1-docker | base ×3 up **81.1m** (`3de203d3f6ab`/`ff9f8dfad71b`/`04630ff69cfe`) — **CONTÍNUO, sem recreate (+60.7m 1:1)** · ai ×3 up **6.8m** (`ab7a34f9066a`/`2f1f24be91c7`/`964d368af462`) — **reciclaram 1×**, campaign_generate ✓, fail1h 0/0/0 | gmb-strict-v7 | `64381c1d299829c6` (inalt.) | base **128-232** · ai **0/0/0** | base 128-232 · ai 0 | base 8 · ai 0 | **1.36-1.4 / 18** | base+campaign_**send** (cs=true) · browser,security,ai,verify+campaign_**generate** (cg=true, ×3) — lh maxAck **20** |

_Nota @09:21: **SEM deploy novo** — env-hashes **5/5 INALTERADOS** vs @08:22. de1/oracle1/oracle2 recriaram (ids novos, env inalt., version
inalt.) = **code pull** (git); laptop reciclou (churn residencial). hel1 base ×3 **CONTÍNUO** (mesmos ids, +60.7m 1:1, sem recreate); hel1 ai
×3 **reciclaram 1×** (mesmos ids, up 6.8m) MAS **fail1h 0/0/0** (melhor estado, não crash-loop, uptimes a crescer). **10 workers, 1/host +
hel1 6, sem duplicados.** hel1 base fail1h 128-232 = **só PG subdomains** (ECONNREFUSED+ETIMEDOUT, retry-only, under-pressure 0); ai 0/0/0.
campaign_generate 0/0/0 não-órfão servido pelos 3 ai (waiting 3). Snapshot FRESCO (beatAge <10s). 0 crash/SyntaxError, **0 erro-CH** no
buffer; 0 gmb-block; 0 under-pressure (Directus saudável). **HostOverloaded LXC limpo: `/api/alerts` count=0.** Ressalva: write-path CH
(lighthouse→CH) AINDA por exercitar dentro do K=3 (lighthouse drenado, ai idle)._

## Sob observação (deploy recente)

| Host | Evento | Detetado | Até (ronda/expiry) | Baseline pré-deploy | Observações | Veredicto |
|---|---|---|---|---|---|---|
| **hel1-docker (workers — migração CH)** | recreate dos 6 workers p/ CLICKHOUSE_URL novo (env-hash `6b5a435f`→`64381c1d`) | 2026-07-18 ~08:22 | R3/3 (próx. ronda) | pré: base up 864m / ai up 313-333m, env `6b5a435f` | **08:22 (R1/3):** 6 workers de volta, up 20.3-20.4m 1:1, roles corretos, campaign_generate 0/0/0 não-órfão, 0 crash/erro-CH. **09:21 (R2/3):** base ×3 mesmos ids up **81.1m CONTÍNUO** (+60.7m 1:1, sem re-reset), ai ×3 mesmos ids reciclaram 1× (up 6.8m) mas **fail1h 0/0/0** (melhor estado, não crash-loop), roles corretos, campaign_generate 0/0/0 (ai waiting 3), **0 crash/SyntaxError/erro-CH**, load 1.36-1.4/18. env-hash inalt. **Write-path CH AINDA por exercitar** (lighthouse pend 0, ai idle done1h 0). | **✅ SAUDÁVEL R2/3.** Falta R3/3: workers estáveis + **1 lote lighthouse a gravar no CH novo sem erro** (ainda não houve carga lighthouse) |
| **np-server (dashboard — migração CH)** | recreate da dashboard p/ CLICKHOUSE_URL novo | 2026-07-18 ~08:22 | R3/3 (próx. ronda) | pré: dashboard a apontar CH em de-analytics (301, apagada) | **08:22 (R1/3):** endpoints respondem, clickhouse.up=TRUE. **09:21 (R2/3):** todos os endpoints respondem (`/api/alerts`/`/api/config`/`/api/workers`/`/api/queues`/`/api/logs`/`/api/fleet/env`), **`/api/config` → clickhouse.up=TRUE** (CH 100.120.43.49:8123 acessível). | **✅ SAUDÁVEL R2/3 — dashboard estável e CH novo acessível.** Confirmar clickhouse.up=true +1 ronda |
| **hel1-docker (ai×3 reciclagem)** | reciclagem residual dos 3 ai sob sweep lighthouse >50 | 2026-07-17 ~18:07 | streak RESETADO pelo recreate da migração | ai up 2-10m, fail1h 142-168 @18:32 (maxAck 40) | **08:22:** streak resetada pelo recreate da migração CH (ai ids novos, up 20.3m, fail1h 0/0/1). **09:21:** os 3 ai (mesmos ids `ab7a34f9`/`2f1f24be`/`964d368a`) **reciclaram 1×** na janela (up 6.8m) MAS **fail1h 0/0/0** (0 falhas), load 1.36/18, 0 SyntaxError — reciclagem residual documentada, **não crash-loop, sem perda**. Sem lighthouse a correr (pend 0) → não é o sweep desta vez. | **Observação — reciclagem residual persiste (1× nesta ronda) mas fail1h 0/0/0 = benigno.** Lever residual `LIGHTHOUSE_CONC` hel1 se recorrer sob sweep. Incidente CLOSED 20260716 (sem perda) |
| **hel1-docker (HostOverloaded)** | 3 alertas `NetProspectHostOverloaded` (blackbox/pve exporters + PMG) | 2026-07-17 ~23:21 (1ª c/ alerts live) | **FECHADO @00:21** | n/a | **09:21: continua limpo** — `/api/alerts` count=**0** (0 HostOverloaded; inclui os targets C5 nats/redis/postgres do CT200). Regra `np_host_cores>=4` a segurar os falsos-positivos de camada Proxmox/CT. | **✅ FECHADO — falsos-positivos LXC eliminados pela correção da regra (`np_host_cores>=4`).** Fora da observação. |
| **hel1-docker (PG subdomains)** | `ETIMEDOUT`→agora **`ECONNREFUSED`** `91.199.212.73:5432` em subdomains | 2026-07-17 ~18:07 | +K (cont.) | 0 PG @16:21 | **08:22:** 59 linhas ETIMEDOUT. **09:21: ASSINATURA MUDOU** — 26 no buffer (14 **ECONNREFUSED** + 12 ETIMEDOUT), **↓ vs 59** (raw baixou). Alvo = **CT Postgres/PgBouncer** (NÃO ClickHouse; migração não tocou PG). ECONNREFUSED = PgBouncer/PG a **RECUSAR** (pool/max_client_conn cheio sob maxAck 16). **Confinado a 1 job** (subdomains — 0 spread a enrich/score/whois/geoip, 0/0/0), **retry-only** (73 ↻ + 14 ✗ subdomains, sem term), hel1(12)+laptop(14). Explica base fail1h 128-232 (under-pressure 0). | **Observação (watchlist escrita PG) — assinatura ECONNREFUSED nova mas raw ↓, confinada a 1 job.** Nenhum gatilho de escalada atingido. **Escalar a incidente se ECONNREFUSED persistir/crescer OU o refuse do PgBouncer atingir OUTROS jobs de escrita PG**; considerar teto `SUBDOMAINS_MAX_ACK` |
| **np-wk-de1 (uptime quirk)** | id contínuo mas uptime cresce menos que wall-clock | 2026-07-17 ~20:28 | **RESOLVEU @01:20** | up 36.3m @23:21 | **08:22:** de1 RECRIOU (id novo `818202443a8e`, up 5.2m, code pull env inalt.) — o quirk era do id `ef79e1eb4c3c` já resolvido; recreate limpo, load 0/6, 1 worker, fail1h 0. | **✅ RESOLVIDO — quirk não recorreu; recreate desta ronda é code pull normal (env inalt.), não regressão.** Nota histórica |

_Fechados esta ronda (saíram da observação):_
- **dashboard `/api/workers` (staleness) — NÃO RECORREU @21:23** — o snapshot desta ronda veio FRESCO (beatAge 1-10s, max
  beat a <11s do NOW; ids base/oracle a crescer 1:1 com o relógio). A resposta cached ~1h54 velha de @20:28 não se repetiu →
  sai da observação. Mitigação mantém-se de pé (validar `max(beat)` fresco antes de comparar snapshots como série temporal).
- **oracle-e2-1 — drain de recreate FECHADO @18:07** — era 2 workers @16:21 (overlap `--no-deps`); agora **1 worker
  único** `eec948ad5e68` up 2.3m load 0.41/2. Resolveu como previsto; sem regressão.
- **de1 + oracle-e2-1 + oracle-e2-2 — INCIDENTE containers DUPLICADOS: FECHADO @16:21** (commit `b1d6cf9`
  pull-deploy.sh passo 0 derruba projeto órfão + power-cycle do de1 VMID 800). Confirmado: **de1 = 1 worker**
  (`ecae4845abeb`, load **1.54/6c** vs 15.61, a **reportar beats** de novo → observabilidade também fechada),
  oracle-e2-2 = 1 (auto-limpou), hel1 = 6. Único resíduo = drain de recreate transitório em oracle-e2-1 (linha
  acima). Ver [`incidents/20260717-duplicate-worker-project-npworker.md`](incidents/20260717-duplicate-worker-project-npworker.md).
- **hel1-docker** — migração `campaign_generate`→`ai` + lighthouse maxAck **20**: **VALIDADO @15:27**, mantém-se
  @16:21 (ai servem campaign_generate 0/0/0 não-órfão waiting 3; lighthouse maxAck 20 em todos os browser; 6
  workers beats 0-7s, uptimes a crescer base 127m / ai 6-38m, sem crash-loop; ai fail1h 38-58 = retries lighthouse
  do sweep, não regressão).

_Validados esta ronda (saem da observação):_
- **gpedro-laptop** — deploy `browser`+`GMB_MAX_ACK=5`+`LIGHTHOUSE_CONC=3` **COMPLETOU @14:23** (era config antigo @13:36):
  `5a65bb0babaf` up 9.5m role tem `browser`, gmb maxAck 5 (inflight 5), lighthouse conc 3/maxAck 12, **0 bloqueios gmb**
  (nem `/sorry/`/recaptcha) → **VALIDADO**. Vigiar residual: se bloqueios gmb subirem com maxAck 5 = sinal p/ baixar.
- **np-server (dashboard)** — `/api/autoscale` devolve **JSON com bottlenecks** (era HTML @13:36) → rebuild propagou → **VALIDADO**.

_Validados em rondas anteriores (mantêm-se; recreate só reinicia a janela sem alterar veredicto do role):_
- **gpedro-laptop** — role `residential,security,base` **VALIDADO @11:35 (3/3)**; @12:20 transição p/ 1 worker
  (`738badb43ba9`), @12:38 **ESTÁVEL** (mesmo id contínuo 8→23min a crescer, fail 0, beatAge 5s). Transição concluída,
  role imutável, sem regressão, sem duplicado. Fora da observação.
- **np-wk-de1 / oracle-e2-1 / oracle-e2-2** — roles já VALIDADOS 3/3 em rondas anteriores; os recreates @12:34 (commits
  `2340aaf`/`12f4e22`) só reiniciam a janela de observação do *agent code novo*, não mudam o veredicto do role.

_Nota sobre o "burst de recreate" @11:2x–11:5x:_ 5 commits entre 10:47 e 11:42 (`9c37de6`→`13d8f88`) fizeram os
hosts git (de1/oracle1/oracle2) recriar a cada pull. Cada commit novo **reinicia a janela de observação** desses
hosts (uptime recua) mas o *role/consumers* já foram validados 2-3× — o veredicto do role não muda. env-hash
inalterado (mudanças de code, não `.env`), version fixa (`gmb-strict-v7` é build-tag), roles inalterados. Uptimes
a crescer, fail~0, 0 ✗/↻ na frota → **churn de recreate esperado, não crash-loop**. Quando os commits assentarem
os recreates param.

_Propagação hel1 — **CONCLUÍDA @14:23** (por restart manual, não `.env`):_
- **hel1-docker** — `SKIP_GIT=1`. O **restart manual @14:23** adotou o `jobs.js` novo: os 3 `ai` passaram a
  subscrever `campaign_generate` (cg=True) e os 3 `base` largaram-no (cg=False, mantêm `campaign_send`).
  `campaign_generate` NATS 0/0/0 não-órfão, waiting 3 (ai). Transição `campaign_generate`→`ai` **fechada** (era
  a pendência arrastada desde 11:35). Histórico da espera (para referência):
  - **11:35Z: AINDA NÃO recriou** — uptime 75min (a crescer desde ~1784283600, sem reset); os 3 workers base
    continuam a subscrever `campaign_generate`+`campaign_send`, os 3 `browser,security,ai,verify` NÃO têm
    `campaign_generate` (rota antiga intacta). `campaign_generate` pend/orphans/redeliv = 0 (não órfão) ✓.
  - **11:53Z: AINDA NÃO recriou** — uptime 93min (a crescer, sem reset; SKIP_GIT não reagiu aos commits git);
    os 3 base ainda subscrevem `campaign_generate`, os 3 `ai` ainda NÃO. `campaign_generate` NATS 0/0/0 (não
    órfão) ✓. Serve pela rota antiga. Continuar a vigiar até recriar (só em mudança de `.env`).
  - **12:13Z: AINDA NÃO recriou** — uptime 113min (=93+20, contínuo, sem reset; env-hash `6b5a435f5970bfdf`
    inalterado → nada de `.env` novo, SKIP_GIT ignora os commits git 9d0b0a3/39e0819). Os 3 base ainda subscrevem
    `campaign_generate`+`campaign_send`, os 3 `ai` ainda NÃO. `campaign_generate` NATS 0/0/0 (não órfão) ✓. fail1h 0.
    Serve pela rota antiga. Continuar a vigiar até recriar (só em mudança de `.env`).
  - **12:20Z: AINDA NÃO recriou** — uptime 120min (=113+7, contínuo, sem reset; env-hash `6b5a435f5970bfdf`
    inalterado). Os 3 base (`1601a684f74b`/`6f34e244264b`/`b28ab000fb92`) ainda subscrevem `campaign_generate`+
    `campaign_send`; os 3 `ai` (`1b1b710a6eb5`/`9262e5b482dd`/`5821ae0ca35b`) ainda NÃO. `campaign_generate` NATS
    0/0/0 (não órfão) ✓. fail1h 0, fail24h ~921 (quota verify, esperado). Serve pela rota antiga. Continuar a vigiar.
  - **12:38Z: AINDA NÃO recriou** — uptime 135min (=120+15, contínuo, sem reset; env-hash `6b5a435f5970bfdf`
    inalterado → os commits git `2340aaf`/`12f4e22` que recriaram de1/oracle1/oracle2 NÃO tocam o `.env`, SKIP_GIT
    ignora-os). Os mesmos 3 base ainda subscrevem `campaign_generate`+`campaign_send`; os 3 `ai` ainda NÃO.
    `campaign_generate` NATS 0/0/0 (não órfão) ✓. fail1h 0, fail24h ~921 (quota verify, esperado). Rota antiga intacta.
  - **12:52Z: AINDA NÃO recriou** — uptime 151min (=135+16, contínuo, sem reset; env-hash `6b5a435f5970bfdf`
    inalterado → os 2 commits git novos `98f0982`/`ba93076` são dashboard/proxmox, não tocam o `.env`, SKIP_GIT
    ignora-os). Os mesmos 3 base (`1601a684f74b`/`b28ab000fb92`/`6f34e244264b`) ainda subscrevem `campaign_generate`;
    os 3 `ai` (`1b1b710a6eb5`/`9262e5b482dd`/`5821ae0ca35b`) ainda NÃO. `campaign_generate` NATS 0/0/0 (não órfão) ✓.
    fail1h 0, fail24h ~921 (quota verify, esperado). Rota antiga intacta. Continuar a vigiar até recriar (só `.env`).
  - **13:06Z: AINDA NÃO recriou** — uptime 166min (=151+15, contínuo, sem reset; env-hash `6b5a435f5970bfdf`
    inalterado → o commit git novo `717444c` (coverage-gate) é dashboard/coverage, não toca o `.env`, SKIP_GIT
    ignora-o). Os mesmos 3 base (`1601a684f74b`/`b28ab000fb92`/`6f34e244264b`) ainda subscrevem `campaign_generate`;
    os 3 `ai` (`5821ae0ca35b`/`9262e5b482dd`/`1b1b710a6eb5`) ainda NÃO. `campaign_generate` NATS 0/0/0 (não órfão) ✓.
    fail1h base 33-47 / ai 11-19 (Directus under-pressure naks + gmb domain-mismatch sob o sweep, 0 ✗). Rota antiga
    intacta. Continuar a vigiar até recriar (só `.env`). **NOTA:** o rebuild do dashboard (717444c) NÃO propaga o
    `jobs.js` novo ao hel1 — a transição `campaign_generate`→`ai` do hel1 continua a depender de um recreate por `.env`.

<!--
Exemplo de regressão (abrir incidente):
| np-wk-de1 | recreate | 2026-07-17 12:00 | +3 | fail1h 0 | up reset 3× seguidas (crash-loop) — ver docs/incidents/… | REGRESSÃO |
-->
