# Runbook — PostHog **Cloud** (product analytics, sem self-host)

> **Decisão (2026-07):** o PostHog self-hosted é pesado demais (o stack "hobby" oficial são ~40
> serviços — ver [`runbook-analytics-de.md`](runbook-analytics-de.md) §7). O **Cloud** resolve tudo:
> sem VM, sem manutenção, e o **free tier chega-nos à larga** (1M eventos/mês; nós enviamos os
> `change_events` + emails + uso do dashboard → uma fração disso).
>
> **O Cloud NÃO liga ao nosso ClickHouse.** Ele tem o ClickHouse dele; nós **enviamos eventos** via a
> API `/capture/`. Os `change_events` continuam a ir para o **nosso** ClickHouse (Fase E, `de-analytics`)
> na mesma — o PostHog é um destino ADICIONAL e opcional. São coisas independentes.

## O que já está pronto no sistema

Nada de código a mudar — o plumbing existe:

- `lib/metrics.js` → `capture('np_<evento>', domain, {…})` por cada **change_event** detetado (só se
  `POSTHOG_HOST` + `POSTHOG_KEY` estiverem definidos; senão é no-op).
- `worker/handlers.mjs` → `capture('np_email_sent', …)` por cada email de campanha enviado.
- `docker/docker-compose.yml` já passa `POSTHOG_HOST`/`POSTHOG_KEY` aos workers (`worker`, `worker-base`).

Ou seja: **basta pôr as 2 variáveis no `.env` de cada host e recriar os workers.**

---

## 1. Criar o projeto no PostHog Cloud — **TU fazes**

1. Regista-te em **<https://eu.posthog.com>** (região **EU / Frankfurt** — perto da infra + GDPR).
2. Cria a organização + um projeto (ex.: `NetProspect`).
3. **Project settings → Project API Key** — copia a **Project API Key** (começa por `phc_…`).
4. O host da API do EU é **`https://eu.i.posthog.com`**.

## 2. Ligar os workers (backend: change_events + emails) — **Claude faz**

Pôr as 2 variáveis em cada host que corre workers e recriar:

```bash
# HEL1 (docker/.env)
POSTHOG_HOST=https://eu.i.posthog.com
POSTHOG_KEY=phc_<a-tua-key>
# → cd docker && docker compose up -d --force-recreate worker worker-base

# DE1 (/root/np-worker/.env.worker  E  /root/np-worker-heavy/.env.heavy) — as MESMAS 2 linhas
# → docker compose --env-file <env> up -d --force-recreate

# np-server (dashboard, deploy/server/.env) — para o dashboard mostrar o modo e, se ativado, o snippet
```

Os workers passam a enviar `np_<evento>` (ex.: `np_liveness`, `np_cms_change`, …) e `np_email_sent`.

## 3. (Opcional) Product analytics do DASHBOARD (frontend) — **Claude faz, se quiseres**

Para funis de uso/retenção do próprio dashboard (page views, cliques), adiciona o snippet JS do PostHog
ao `dashboard/public/index.html` (`<head>`), com a mesma key. Isto é **separado** do backend acima e só
mede o uso da UI. **Atenção:** o dashboard está atrás do Authentik → é uso interno (poucos eventos).

## 4. Verificação

```bash
# 1) um worker confirma que está ligado
docker exec <worker> node -e "import('./lib/metrics.js').then(m=>console.log('posthog:', m.posthogEnabled()))"
# 2) forçar um evento: re-observar um site que mude algo (ou enviar um email de campanha em dry-run=false)
# 3) no PostHog Cloud → Activity / Events: aparecem os np_* em segundos
```

## Notas

- **Free tier:** 1M eventos/mês. Nós enviamos ~1 evento por change_event (raros por site) + emails.
  Muito longe do teto. Se um dia crescer, o PostHog tem `capture` em batch (já usamos 1×/change).
- **Fail-soft:** sem `POSTHOG_HOST/KEY`, `capture()` é no-op — nada quebra. Se o Cloud estiver em baixo,
  o `fetch` falha em silêncio (não bloqueia a pipeline).
- **Privacidade:** enviamos `domain`, `site_id`, `old/new_value`, `severity` — dados de negócio, não PII
  de pessoas. Rever se algum `new_value` puder conter email antes de ativar em massa.
- **O nosso ClickHouse de analytics** (`de-analytics`) continua a ser a fonte de verdade das séries
  temporais; o PostHog é só a camada de product-analytics/funis por cima.
