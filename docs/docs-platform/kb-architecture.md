---
title: KB federada + chat de IA (arquitetura)
type: explanation
module: dashboard/docs
tags: [docs, kb, rag, chat, qdrant, ollama]
visibility: internal
status: living
updated: 2026-07-20
---

# KB federada + chat de IA

A base de conhecimento é **modular e federada**: cada doc pertence a um **módulo** (`module:` no frontmatter,
espelhando o futuro monorepo — ver `config/kb-registry.json`), e a pesquisa federa sobre os módulos ativos do
**perfil** do deploy. Os planos por cliente e os limites vivem em `config/plans.json` + `lib/entitlements.js`.

## Pipeline

```
docs/*.md ──build-content.mjs──► content.json (page.module + node.module)
                                      │
                          kb-ingest.mjs (chunks → embeddings locais 384-dim)
                                      ▼
                     Qdrant: 1 coleção `netprospect_kb` + payload.module
                                      │
        kb-http (mcp/server.mjs): /search /modules /chat /chat/providers
                                      ▼
                 SPA (GraphView): chat + citações que acendem os nós
```

## Federação — coleção única + filtro

Em vez de uma coleção Qdrant por módulo (que **esgota o Qdrant** a partir de ~13 coleções — RocksDB IO error),
usa-se **uma coleção** `netprospect_kb` com `payload.module`, e a federação por-perfil faz-se por **filtro**:
`registry.moduleFilter(profile)` → `{must:[{key:'module', match:{any:[…]}}]}` (null se todos ativos). Escala a
100+ módulos. Ver `docs-site/kb/registry.mjs`.

## Chat multi-modelo

`POST /api/kb/chat` (SSE: `event: cite|token|done`). Providers (`GET /chat/providers`):
- **`retrieval`** (base, sempre) — devolve extractos citados, sem LLM.
- **`ollama`** (flag-gated: `DOCS_OLLAMA_ENABLED` + `OLLAMA_URL`) — RAG com `gemma3:4b` em streaming.
- **CLIs externos** (claude/codex/cursor/gemini/…) — **Fase 2**, precedência se houver keys.

As citações são etiquetadas por módulo e ligam a `#/<slug>`; na página do Grafo, acendem o nó correspondente.
Observabilidade `$ai_generation` para o PostHog (fail-soft).

## Perfis & limites

`DOCS_PROFILE` (starter/pro/enterprise/interno) escolhe os módulos ativos; PostHog pode fazer override por-módulo
(`kb_module_<cat>_<mod>`). Features meteráveis (ex.: `ai-credits`, `contacts-extracted`) têm acesso via flag +
limite por período no plano (`lib/entitlements.js`).

Ver [[README|visão geral]] e [[design-system]].
