---
title: "Incidente: base-workers em ciclo — reload de 1,5M domínios (Directus REST) sob recreate simultâneo"
type: incident
tags: [incident, postmortem]
related: []
owner: infra
status: historical
updated: 2026-07-19
visibility: internal
---

# Incidente: base-workers em ciclo — reload de 1,5M domínios em uníssono pressiona o control-plane

- **Estado:** CLOSED (fix `083b87c` implementado + canary hel1 OK + push para a frota @2026-07-19)
- **Primeiro visto:** 2026-07-19T09:50Z (ronda do monitor)
- **Área:** base-workers (role `base`) + control-plane (Directus 4c) — watchlist DEBUGGING-TODO: *"recreate em loop"*
- **Hosts afetados:** hel1-docker (os 3 base-workers). Mecanismo genérico → qualquer host `base`.
- **NÃO afeta:** heavy-workers (`browser/security/ai/verify`) — não carregam o set de domínios (by-design).

## Sintoma

Os 3 base-workers do hel1-docker reiniciavam o processo em ciclo (~cada 3,5 min: banners "a arrancar"
às 09:38 → 09:50 → 09:52 → 09:56), com **TIMEOUT em TODOS os consumers em simultâneo**
(`⚠ consumer 'X': erro no consumo (TIMEOUT) — re-subscrevo`). 2 dos 3 arrancaram com
`domínios conhecidos=0` (a carga falhou). Descartado: OOM (host com 235GB/257GB livres), autoheal
(não existe), healthcheck (workers não têm), pull-deploy ("sem alterações"). `exitCode=0` → saída
limpa sob a tempestade, relançada pelo `restart: unless-stopped`.

## Evidência (09:50–09:56Z)

- `contexto pronto: … domínios conhecidos=0` em worker-base-2 e -3 (vs 1567798 nos arranques anteriores).
- Heavy-workers logaram `Service "api" is unavailable. Under pressure.` (Directus 503) às 09:56:01 — exatamente
  quando os base reiniciaram.
- `/api/queues`: consumers base a re-subscrever em loop; dashboard `/api/queues` devolveu não-JSON por breves
  momentos (control-plane sob pressão).

## Origem (contexto de código)

`enrich-sites.js:createEnrichContext` carregava os ~1,5M domínios conhecidos via **Directus REST**
(`readItems('sites', { fields:['domain'], limit:-1 })`). Quando vários base-workers recriam juntos (ex.:
um `compose up` da frota por deploy de sessão paralela), os reloads **em uníssono** criam um pico que
pressiona o Directus de 4c → 503 → NATS/consume lentos → timeouts → mais ciclos (loop auto-amplificado).
Bug secundário: `catch { /* coleção vazia */ }` deixava o worker arrancar com **0 domínios em SILÊNCIO**
(dedup do discover + merge de empresa por `orgDomain` degradados).

## Mitigação imediata (na ronda)

Reinício sequencial (1 de cada vez, Directus a ~3ms) dos workers com 0 domínios → recarregaram os
1,5M limpo. Idle + `pending=0` → sem jobs a orfanar.

## Fix durável (`083b87c`)

Loader extraído para **`lib/known-domains.js`** (volume-mounted → chega à frota **sem rebuild**;
`enrich-sites.js` é baked e `COMPOSE_BUILD=0`), chamado pelo `worker/worker.mjs` (que passa
`createEnrichContext({ loadKnownDomains:false })`):

1. **(a) PG direto** — `SELECT domain FROM sites` via `getPool()` do `lib/pgwrite.js` (PgBouncer), não Directus.
   O reload já não toca no control-plane → sem cascata.
2. **(b) retry + guard** — 5 tentativas, backoff 2/4/6/8s; se falhar mesmo, avisa **ALTO** (`⚠⚠ … DEGRADADO`).
   Nunca mais 0 domínios em silêncio.
3. **(c) jitter** — atraso 0-10s no arranque para dessincronizar reloads simultâneos da frota.

**Canary hel1 (14:12Z):** 3 base-workers reiniciados **em simultâneo** (o gatilho do storm) → todos
1.567.798 via PG, cargas desincronizadas (contexto pronto às :42/:46/:47), **Directus sem 503**.

## Observações

- 2026-07-19T09:56Z — auto-recuperou via re-subscribe (resiliência do `consumeLoop`); sem perda de dados.
- 2026-07-19T14:1xZ — fix commitado, canariado no hel1 e feito push (rollout à frota nos ciclos de pull).
- Relacionado: [20260716-lighthouse-aborts-hel1.md](20260716-lighthouse-aborts-hel1.md) (mesma classe de
  pressão do Directus), [20260717-duplicate-worker-project-npworker.md](20260717-duplicate-worker-project-npworker.md).
