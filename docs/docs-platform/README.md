---
title: Plataforma de Docs — visão geral
type: explanation
module: dashboard/docs
tags: [docs, platform, meta]
visibility: internal
status: living
updated: 2026-07-20
---

# Plataforma de Docs

A mini-app de documentação do NetProspect (`docs-site/`) — um **corpus único** de Markdown servido a quatro
consumidores: humanos (site React em `/docs/`), autores (vault Obsidian), **agentes** (MCP + RAG) e exploração
(Open Notebook em `/notebook/`). É o módulo **`dashboard/docs`** da [[netprospect-docs-kb-architecture|KB federada]].

## Peças

- **Site (Vite + React)** — SPA em `docs-site/src/`, servido sob `/docs/` (HashRouter, `base:/docs/`). Sidebar
  Diátaxis colapsável, temas claro/escuro, e a página **Grafo** com [[kb-architecture|chat de IA]].
- **Design-system** — componentes React em `docs-site/src/ui/` que replicam pixel-a-pixel o dashboard base
  (tokens `np-*`). Documentados no **Storybook** (`/docs/storybook/`, secção *UI*). Ver [[design-system]].
- **Conhecimento (KB)** — `content.json` (build a partir de `docs/`) + Qdrant + embeddings locais + o serviço
  `kb-http`. Ver [[kb-architecture]].

## Como escrever docs

Cada `.md` em `docs/` tem frontmatter: `title`, `type` (Diátaxis: tutorial/how-to/reference/explanation/
incident/working), `tags`, `module` (agrupamento na KB — ver [[kb-architecture]]), `visibility`
(internal|public), `status`, `updated`, `owner`. `[[wikilinks]]` resolvem para rotas do grafo. Ver
[[CONTRIBUTING]].

## Build & deploy

`npm run build` (em container `node:20`, porque o np-server não tem node) → `gen:api` + `content` + `vite build`
+ `storybook:build`. O `deploy/docs/build.sh` corre isto no np-server; o `docs-web` (nginx) serve o `dist` por
bind-mount. Ver [[runbook-npm-hel1]] para o proxy.
