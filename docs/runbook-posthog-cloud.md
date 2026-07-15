# Runbook — PostHog **Cloud** (product analytics, sem self-host)

> **Decisão (2026-07):** o PostHog self-hosted é pesado demais (~40 serviços). O **Cloud** (região **EU /
> Frankfurt**) resolve tudo, e o **free tier chega-nos à larga** (1M eventos/mês). O Cloud tem o ClickHouse
> dele; nós **enviamos eventos** via `/capture/`. O nosso ClickHouse (`de-analytics`) continua a ser a fonte
> de verdade das séries temporais — o PostHog é a camada de product-analytics/funis POR CIMA, adicional.

## Duas integrações (independentes, mesmo projeto PostHog)

Há **dois** fluxos de eventos, com **variáveis de ambiente diferentes**. Devem apontar para o **mesmo
projeto** PostHog (mesma `phc_…` key) para os eventos caírem juntos.

| # | Integração | O que mede | Env vars | Código |
|---|---|---|---|---|
| **A** | **Pipeline / workers** | `np_*` (change_events) + `np_email_sent` | `POSTHOG_HOST` / `POSTHOG_KEY` | `lib/metrics.js`, `worker/handlers.mjs` |
| **B** | **Dashboard** (product analytics) | 14 eventos de uso + error tracking + session replay | `POSTHOG_PUBLIC_HOST` / `POSTHOG_PUBLIC_KEY` | `dashboard/public/posthog-init.js`, `dashboard/server.mjs` (SDK client + server-side) |

## Estado atual (o que JÁ está tratado)

- ✅ **Projeto criado** no PostHog Cloud EU (tens acesso ao dashboard).
- ✅ **Integração A** (workers `np_*`): `POSTHOG_HOST/KEY` definidos em **`docker/.env`** (HEL1). `lib/metrics.js`
  ativo. *(Falta confirmar DE1 — ver passo 4.)*
- ✅ **Integração B — server-side**: `POSTHOG_PUBLIC_HOST/KEY` no `.env` (raiz), endpoint `/api/posthog-config`,
  e os eventos server-side (`campaign_created`, `audit_requested`, `report_viewed`, …) via `fetch` ao `/capture/`.
  **Já funcionam** assim que o container servir o código (já serve).
- ✅ **Integração B — bugs de client-side CORRIGIDOS no código** (Claude):
  1. `posthog-js` estava só no `package.json` da **raiz**, mas o dashboard faz build isolado de `dashboard/` →
     **adicionado a `dashboard/package.json`**.
  2. O mount `/vendor` usava `path.join(__dirname, '../node_modules')` → no container resolvia `/node_modules`
     (errado; deps em `/app/node_modules`) → **corrigido para `path.join(__dirname, 'node_modules')`**.

---

## O que FALTA (ordenado) — **começa no Passo 1**

### ▶ Passo 1 — Rebuild do container do dashboard (ativa o client-side) — **Claude faz / tu confirmas**

Sem isto, o `posthog-js` não é instalado no container e o `/vendor/posthog-js` dá 404 → **nenhum** evento
client, session replay ou error-tracking client. Depois dos 2 fixes acima:

```bash
cd docker
docker compose build dashboard && docker compose up -d dashboard
# (dev, se correres o dashboard fora de container: cd dashboard && npm install)
```

### Passo 2 — Terminar o onboarding no PostHog — **TU fazes**

Em **"Which products would you like to use?"**, escolhe:
- ✅ **Product Analytics** (já instrumentado — os 14 eventos)
- ✅ **Session Replay** (grava por default; enorme valor num tool interno)
- ✅ **Error Tracking** (já ligado no `posthog-init.js`)
- *(opcional)* Web Analytics. **Saltar:** Data Warehouse, Experiments, Surveys, MCP, Logs, Workflows, Support.

### Passo 3 — Verificar que os eventos chegam

```bash
# server-side (workers, integração A):
docker exec <worker> node -e "import('./lib/metrics.js').then(m=>console.log('posthog A:', m.posthogEnabled()))"
# client-side (integração B): abre o dashboard, faz uma pesquisa / abre um site / troca o tema
#   → PostHog → Activity/Events: aparecem dashboard_search_submitted, site_detail_opened, theme_toggled…
#   → /vendor/posthog-js/dist/module.full.js deve dar 200 (não 404)
```

### Passo 4 — Fechar pontas — **opcional / mais tarde**

- **DE1 (integração A):** pôr `POSTHOG_HOST/KEY` (as mesmas) em `/root/np-worker/.env.worker` +
  `/root/np-worker-heavy/.env.heavy` e `docker compose … up -d --force-recreate`. *(HEL1 já tem.)*
- **Confirmar o mesmo projeto:** `POSTHOG_KEY` (A) e `POSTHOG_PUBLIC_KEY` (B) devem ser a MESMA `phc_…`.
- **`$pageview` da SPA:** o `posthog-init.js` tem `capture_pageview:false`; se quiseres navegação/retenção,
  capturar `$pageview` na mudança de rota (hash). Nice-to-have.
- **`.env.example`:** documentar `POSTHOG_PUBLIC_HOST/KEY` (+ `POSTHOG_HOST/KEY`) para colaboradores.
- **Insights/dashboard no PostHog:** criar depois de os eventos aparecerem (o wizard deixou um dashboard base:
  project 224592 → dashboard 822272).

---

## Notas

- **Free tier:** 1M eventos/mês — muito longe do teto (uso interno + change_events raros).
- **Fail-soft:** sem as env vars, `capture()` é no-op; se o Cloud cair, o `fetch` falha em silêncio (não bloqueia).
- **Privacidade:** integração A envia dados de negócio (domain, site_id, old/new_value) — rever se algum
  `new_value` puder conter email. Integração B (session replay) grava a UI interna — só a equipa a usa.
