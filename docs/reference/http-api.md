---
title: Referência da API HTTP
type: reference
tags: [api, dashboard, generated]
related: [[README]]
owner: plataforma
status: living
updated: 2026-07-19
visibility: internal
---

<!-- GERADO por docs-site/scripts/gen-http-api.mjs — NÃO editar à mão. Correr: npm run gen:http -->

# Referência da API HTTP (dashboard)

**88 endpoints** expostos por `dashboard/server.mjs`. Servido em `netprospect.netmaster.pt`
**atrás do Authentik** (NPMplus); as rotas `/t/*` e `/r/*` (tracking público) são exceções abertas.

## Filas (NATS)

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/queues` | /api/queues — estado da stream + profundidade por consumer (a antiga /api/workers). |
| `GET` | `/api/queues/:consumer/jobs` | abrir um 2.º consumer no mesmo subject; varremos as seqs mais recentes e filtramos). |
| `POST` | `/api/queues/:consumer/orphans` | requeue: lê os payloads órfãos (via next_by_subj), purga, e re-publica (sem msgId → aceite). |
| `POST` | `/api/queues/:consumer/purge` | Purga TODOS os pendentes de um consumer (o subject inteiro). |
| `POST` | `/api/queues/jobs/delete` | Apagar jobs por seq (bulk). Prioritizar NÃO é suportado num workqueue FIFO (ver README Follow-ups). |

## Frota (deploy / env / workers)

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/fleet/env` | Lista os hosts com .env guardado (para a Servers page saber quais têm store). |
| `GET` | `/api/fleet/env/:host` | Editor (browser, tailnet-gated como o resto do dashboard): lê/grava o .env de um host. |
| `PUT` | `/api/fleet/env/:host` | — |
| `POST` | `/api/fleet/metrics/:host` | — |
| `GET` | `/api/fleet/pull/:host` | (os agentes correm em qualquer nó da tailnet). Sem token configurado → tailnet-gated. |
| `GET` | `/api/fleet/targets` | Lista de nós da frota (host + IP reportado) → cada agente pinga estes para a matriz de latência. |
| `GET` | `/api/workers` | — |
| `GET` | `/api/workers/:id` | — |

## Autoscaler

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/autoscale` | — |

## Cobertura

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/coverage` | — |
| `GET` | `/api/data-coverage` | — |

## Moloni (contabilidade)

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/moloni/avencas` | — |
| `POST` | `/api/moloni/credit-note` | Nota de Crédito ligada a um documento original (associated_documents + related_id). Rascunho por defeito. |
| `POST` | `/api/moloni/customers` | — |
| `GET` | `/api/moloni/documents` | ── Moloni — leitura (A4): as páginas Contabilidade lêem o Directus sincronizado. ── |
| `POST` | `/api/moloni/documents` | — |
| `POST` | `/api/moloni/documents/:id/finalize` | — |
| `GET` | `/api/moloni/documents/:id/pdf` | PDF de um documento fechado (status=1) — via Moloni (getPDFLink → landing → bytes). |
| `GET` | `/api/moloni/products` | — |
| `POST` | `/api/moloni/products` | — |
| `POST` | `/api/moloni/sync` | (como os workers). Falha graciosa (502) enquanto não estiver montada — não parte o arranque. |

## Agendamentos

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/agendamentos` | — |
| `POST` | `/api/agendamentos` | — |
| `POST` | `/api/agendamentos/:id/cancel` | — |

## Campanhas / Import

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/campaigns` | — |
| `POST` | `/api/campaigns` | — |
| `GET` | `/api/campaigns/:id` | — |
| `DELETE` | `/api/campaigns/:id` | — |
| `PATCH` | `/api/campaigns/:id` | PATCH — mudar a fase (escada de temperatura) de uma campanha. Aceita só campos seguros. |
| `POST` | `/api/campaigns/:id/generate` | Constrói a audiência + cria os e-mails (pending) + enfileira geração de cópia. |
| `POST` | `/api/campaigns/:id/send` | Enfileira envio dos e-mails prontos. |
| `POST` | `/api/import` | — |
| `POST` | `/api/import/preview` | 1) Preview: devolve cabeçalhos + amostra para o UI mapear as colunas. |

## Diretório / Segmentos / Relatórios

| Método | Caminho | Descrição |
|---|---|---|
| `POST` | `/api/audit/:domain` | ?only=wpscan (ou lista) corre só esses passos (ex.: botão WPScan). O worker lê job.only. |
| `POST` | `/api/audit/segment` | "Auditar tudo" numa audiência/segmento: enfileira audit p/ os sites que batem o filtro. |
| `GET` | `/api/contacts` | --- Contacts directory ------------------------------------------------------ |
| `GET` | `/api/contacts-by-ids` | Resolve ids de contactos → detalhes (para mostrar os contactos já associados a um template). |
| `GET` | `/api/contacts-search` | Pesquisa de contactos (popup do template): por nome/email/empresa. Só com email. |
| `GET` | `/api/contacts.csv` | — |
| `PATCH` | `/api/contacts/:id` | — |
| `GET` | `/api/directory` | --- Business Directory (sites) --------------------------------------------- |
| `GET` | `/api/directory.csv` | — |
| `GET` | `/api/report/:id` | Report individual (para o report-viewer human-readable). Antes do catch-all. |
| `GET` | `/api/segments` | --- Segments (saved views) CRUD ------------------------------------------- |
| `POST` | `/api/segments` | — |
| `PUT` | `/api/segments/:id` | — |
| `DELETE` | `/api/segments/:id` | — |

## Verify (validação de email)

| Método | Caminho | Descrição |
|---|---|---|
| `POST` | `/api/verify/enqueue` | pela frota (contador+lock por-chave no Redis, lib/verify-providers.js) — isto só ALIMENTA a fila. |

## Config / Telemetria

| Método | Caminho | Descrição |
|---|---|---|
| `POST` | `/api/alertmanager-webhook` | — |
| `GET` | `/api/alerts` | — |
| `GET` | `/api/config` | — |
| `GET` | `/api/isps` | --- ISPs descobertos (B3) — agrega sites.isp (paginado, com % qualificados) -- |
| `GET` | `/api/logs` | Logs agregados da frota (merge dos np:wk:<id>:log de todos os workers vivos). Antes do catch-all. |
| `GET` | `/api/stats` | --- Overview / KPIs + breakdowns ------------------------------------------- |

## Agentes IA

| Método | Caminho | Descrição |
|---|---|---|
| `POST` | `/api/agents/audience` | — |
| `POST` | `/api/agents/campaign-copy` | — |
| `POST` | `/api/agents/chat` | Orquestrador — chat que classifica a intenção e delega no sub-agente certo. |
| `GET` | `/api/agents/health` | Estado do Ollama on-prem (chip de saúde nas páginas AI). Verifica reachability + se o modelo existe/está quente. |
| `POST` | `/api/agents/plan` | — |

## Triggers / Timeline

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/timeline` | Timeline de um site (por domínio): observações agrupadas por métrica. |
| `GET` | `/api/triggers` | Feed de gatilhos (change events) recentes; filtros severity/event/domain/since. |

## Tracking público (open/click/unsub/redirect)

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/r/:token` | — |
| `GET` | `/t/c/:token` | — |
| `GET` | `/t/o/:token` | — |
| `POST` | `/t/u/:token` | Opt-out: POST = one-click (List-Unsubscribe-Post do Gmail/Yahoo); GET = clique no link. |
| `GET` | `/t/u/:token` | — |

## Métricas Prometheus

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/metrics` | — |

## Outros / raiz

| Método | Caminho | Descrição |
|---|---|---|
| `GET` | `/api/clients` | --- Clientes (B3) — empresas convertidas (companies.is_client) -------------- |
| `POST` | `/api/clients/:companyId` | Marcar/atualizar/desmarcar uma empresa como cliente (do drawer do site ou da página). |
| `GET` | `/api/companies/search` | Live search de empresas por nome/domínio OU por nome de contacto (p/ marcar cliente). |
| `GET` | `/api/email-templates-list` | Templates disponíveis (para a vista de empresa: "adicionar contactos a um template"). |
| `POST` | `/api/email-templates/:id/contacts` | Adicionar/remover contactos de um template (popup + vista de empresa). {add:[ids], remove:[ids]} |
| `GET` | `/api/health` | — |
| `GET` | `/api/outreach` | --- Outreach: funil de campanhas + emails recentes (antes do catch-all) --- |
| `GET` | `/api/posthog-config` | — |
| `GET` | `/api/site` | --- Site detail (hostnames + tech + contacts) ------------------------------ |
| `PATCH` | `/api/sites/:id/industry` | — |
| `GET` | `/api/subscriptions` | — |
| `POST` | `/api/subscriptions` | — |
| `PUT` | `/api/subscriptions/:id` | — |
| `DELETE` | `/api/subscriptions/:id` | — |
| `POST` | `/api/subscriptions/:id/campaign` | preenche os e-mails com o template (variáveis substituídas, status=ready). Sem → draft p/ gerar por IA. |
| `USE` | `/vendor` | — |
