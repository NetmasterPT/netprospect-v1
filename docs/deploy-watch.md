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

_Snapshot @ 2026-07-17 ~11:2x (ronda de arranque; semeada após a propagação do commit 9c37de6). O monitor
recalcula e reescreve estes valores a cada ronda a partir de `/api/workers` + `/api/fleet/env/<host>`._

| Host | uptime(min) | version | env-hash | fail1h | fail24h | done1h | load | roles efetivos (via consumers) |
|---|---|---|---|---|---|---|---|---|
| np-wk-de1 | 5 | gmb-strict | `6623b46c0a1a6819` | 0 | 0 | 0 | 0.01 | security, browser |
| gpedro-laptop | 4 | gmb-strict | `d08c7df4e935c1c7` | 0 | 0 | 2660 | 0.46 | residential, security, base |
| oracle-e2-1 | 9 | gmb-strict | `3a70ac1a9d2b6a86` | 15 | 15 | 930 | 0.25 | base |
| oracle-e2-2 | 7 | gmb-strict | _(sem store próprio; herda)_ | 7 | 7 | 690 | 0.66 | base |
| hel1-docker | 56 | gmb-strict | `d1143fd958fe67cf` | 656 | 913 | 25372 | 0.75 | browser, security, ai, verify, base(×3 réplicas) |

## Sob observação (deploy recente)

| Host | Evento | Detetado | Até (ronda/expiry) | Baseline pré-deploy | Observações | Veredicto |
|---|---|---|---|---|---|---|
| np-wk-de1 | recreate (env: role `security,browser`, conc nuclei 3/wpscan 2) | 2026-07-17 ~10:5x | +3 rondas (~11:5x) | (idle antes) | up 5min, consumers=security+browser ✓, fail1h 0, load 0.01 | a validar (1/3) |
| gpedro-laptop | recreate (env: role `residential,security,base`) | 2026-07-17 ~11:1x | +3 rondas (~12:0x) | gmb-only, done1h ~160 | up 4min, ganhou base, done1h **2660** (a puxar backfill) ✓, fail1h 0 | a validar (1/3) |
| oracle-e2-1/2 | recreate (git: jobs.js — largou `campaign_generate` do base) | 2026-07-17 ~11:0x | +3 rondas (~11:5x) | base normal | consumers base sem campaign_generate ✓, fail 15/7 (backfill), done ok | a validar (1/3) |

_Pendente de propagação (ainda não recriou; vigiar quando recriar):_
- **hel1-docker** — `SKIP_GIT=1`, só recria em mudança de `.env`; adota o `jobs.js` novo
  (`campaign_generate`→`ai`) apenas no próximo recreate. Até lá serve `campaign_generate` pela rota antiga
  (workers base do hel1, com Ollama) → não órfão. Quando recriar, confirmar que os workers `ai` passam a
  subscrever `campaign_generate` e os `base` o largam.

<!--
Exemplo de regressão (abrir incidente):
| np-wk-de1 | recreate | 2026-07-17 12:00 | +3 | fail1h 0 | up reset 3× seguidas (crash-loop) — ver docs/incidents/… | REGRESSÃO |
-->
