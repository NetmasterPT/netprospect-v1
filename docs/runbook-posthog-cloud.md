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

- ✅ **Projeto criado** no PostHog Cloud EU.
- ✅ **Integração A** (workers `np_*`): `POSTHOG_HOST/KEY` em **`docker/.env`** (HEL1). `lib/metrics.js` ativo.
  *(Falta confirmar DE1 — ver "fechar pontas".)*
- ✅ **Integração B — dashboard ATIVA** (client SDK + server-side). Os 3 bloqueios foram resolvidos (Claude):
  1. `posthog-js` só estava no `package.json` da **raiz** → **adicionado a `dashboard/package.json`**.
  2. mount `/vendor` usava `../node_modules` (resolvia `/node_modules` no container) → **corrigido p/ `node_modules`**.
  3. as env `POSTHOG_PUBLIC_KEY/HOST` não eram passadas ao container → **forwarded no `docker-compose.yml` + `docker/.env`**.
  - Confirmado: `/api/posthog-config` → `enabled:true`; `/vendor/posthog-js/...` → `200`. Container rebuilt+up.

---

## O que FALTA — **começa no Passo 1**

### ▶ Passo 1 — Gerar os primeiros eventos (finaliza o onboarding) — **TU fazes**

O código está ativo; o PostHog só mostra "não configurado / sem dados" até chegar o 1.º evento. **Abre o
dashboard e usa-o** (pesquisa, abre um site, troca o tema, cria uma campanha) → em segundos aparecem em
PostHog → Activity/Events e o onboarding finaliza sozinho.

### Passo 2 — O que cada produto que ativaste precisa

| Produto | Estado | Falta |
|---|---|---|
| Product Analytics | ✅ funciona | nada — os 14 eventos fluem ao usar o dashboard |
| Session Replay | ✅ funciona | nada — grava após o init |
| Error Tracking | ✅ funciona | nada — `window.error`/`unhandledrejection` ligados |
| **Web Analytics** | ⚠️ sem dados | precisa de `$pageview`; o init tem `capture_pageview:false` → **Claude captura na mudança de rota** (~15 min) |
| **AI observability** | ⚠️ sem dados | instrumentar as chamadas LLM (Ollama: indústria + geração de campanhas) → **Claude faz** (~1h; sem custo de API, dá latência/qualidade) |
| **Feature Flags** | ⚙️ config PostHog | criar flags na **UI do PostHog** (TU) → depois Claude liga o `isFeatureEnabled()` onde quiseres |
| **Workflows** | ⚙️ config PostHog | 100% na **UI do PostHog** (TU) — automações, não é código nosso |
| **Logs** | 🚫 saltar | duplicaria os nossos (Redis + worker-telemetry). Recomendo desativar |

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
