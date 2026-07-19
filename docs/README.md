---
title: Índice da Documentação NetProspect
type: reference
tags: [docs, index, meta]
related: [[CONTRIBUTING]]
owner: plataforma
status: living
updated: 2026-07-19
visibility: internal
---

# 📚 Documentação NetProspect — Índice

Ponto de entrada de **todo** o conhecimento da plataforma. Organizado por [Diátaxis](https://diataxis.fr)
(explanation · how-to · reference · incident · working). Para escrever/atualizar docs, ver [[CONTRIBUTING]].

> [!info] Este índice existe para acabar com os "docs órfãos"
> A auditoria [[DOC-AUDIT]] encontrou 26 dos 35 docs sem qualquer link de navegação. **Todo o doc novo
> tem de ser adicionado aqui**, na secção da sua categoria.

## 🚀 Começar aqui
- **[../README.md](../README.md)** — overview mestre do projeto (o que é, pipeline, infra, roadmap).
- [[CONTRIBUTING]] — como escrever docs (Diátaxis + frontmatter + wikilinks).
- [[DOC-AUDIT]] — auditoria de documentação (o que está documentado / drift / em falta).

## 🧠 Explanation — como funciona / porquê
- [[distributed-fleet]] — arquitetura da frota distribuída (hosts, tailnet, control-plane).
- [[stack-isolation]] — racional de colocação dos serviços por perfil de I/O.
- [[observability]] — stack de observabilidade (métricas `np:host:*`, Prometheus, Grafana, Jaeger, alertas).
- [[GMB-README]] — estratégia Google My Business (v6 morada→nome, gating residential).

## 🛠️ How-to — runbooks & operações

### Infra / frota (por host)
- [[runbook-server-hel1]] — np-server (Directus, dashboard, NATS, Redis, crons, Documenso).
- [[runbook-db-host]] — np-db (Postgres 16 + PgBouncer + PostGIS).
- [[runbook-minio-de1]] — de-minio (MinIO; também corre o piloto Reacher+Dante).
- [[runbook-ollama-hel1]] — hel1-ollama (Ollama CPU).
- [[runbook-worker-vms]] — VMs worker (base/verify, Docker, Tailscale).
- [[runbook-laptop]] — gpedro-laptop (residential/GMB).
- [[runbook-laptop-autodeploy]] — auto-deploy PULL (systemd Linux + Windows Task + exceções).
- [[runbook-analytics-de]] — ClickHouse/analytics ⚠️ `status: historical` (migrou para hel1-analytics).
- [[runbook-posthog-cloud]] — PostHog Cloud EU.
- [[deploy-watch]] — deteção de recreate por sinais centrais.

### Outreach / envio & validação de email
- [[outreach-ops/README|Outreach-ops (índice)]] — visão geral da frota de outreach.
- [[00-port25-and-ips]] — porto 25 + IPs limpos + higiene de blocklist.
- [[01-validation-fleet]] — frota de validação (Dante/Reacher).
- [[02-reacher]] — Reacher (verificação SMTP self-hosted).
- [[dns-per-domain]] — DNS/PTR por domínio (FCrDNS).
- [[03-sending-fleet]] · [[04-warmup]] · [[05-esp-ladder]] · [[06-aws-ses-mautic]] — envio, warm-up, ladder ESP.

### Fontes de dados / chaves
- [[subdomain-sources-keys]] — chaves das fontes de subdomínios (certspotter/securitytrails/censys/subfinder) + Wordfence.

## 📖 Reference — factos, modelos, catálogos
- **Comercial (modelo de dados + páginas):** [[comercial/README|Comercial (índice)]] · [[empresas]] · [[contactos]] · [[segmentos]] · [[icps]] · [[campanhas]] · [[templates]] · [[subscricoes]].
- **API (gerada — F1):** `reference/api/` (JSDoc de `lib/`,`worker/`,`dashboard/`) + `openapi.json` (rotas HTTP). *(a criar)*
- **Inventário da frota:** [[LOAD-DISTRIBUTION]] — tabela viva de hosts/IPs/VMIDs.
- **Benchmarks:** [[BENCHMARK]] (concorrência) · [[DATA-BENCHMARK]] (ground-truth de dados).

## 🚨 Incidents — post-mortems
- [[incidents/README|Incidents (template)]].
- [[20260716-lighthouse-aborts-hel1]] — Lighthouse abortava workers (unhandledRejection). **Fechado.**
- [[20260717-duplicate-worker-project-npworker]] — projeto worker duplicado. **Fechado.**

## 📝 Working docs — vivos (não são referência estável)
- [[TODO]] — backlog ativo.
- [[DEBUGGING-TODO]] — watchlist do monitor de saúde.
- [[DEBUG-FOUND]] — achados de debugging.
- [[orphan-offenders]] — log de rondas / retry-policy ⚠️ (candidato a poda, ver [[DOC-AUDIT]]).

## 🗂️ Planos ativos (`.claude/plans/current/`)
- `docs-plan.md` — este projeto (plataforma de docs & conhecimento).
- `moloni-crm-integration.md` — integrações Moloni + Fundação F + Agendamentos G.

---
> [!note] Meta-docs a arquivar
> `posthog-setup-report.md` (output one-shot do wizard) está marcado para arquivo — ver [[DOC-AUDIT]] §B.
