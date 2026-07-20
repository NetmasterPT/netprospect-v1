# Plano — Plataforma de Documentação & Conhecimento (NetProspect)

> Ficheiro de plano da sessão. **Na aprovação, gravar a cópia canónica em
> `.claude/plans/current/docs-plan.md`** (e remover o rascunho interino `docs-platform.md`).
> Fundamentado com exploração live read-only da frota (NPMplus, np-server, Ollama, np-db).

## Context

**Problema.** A auditoria de docs (`docs/DOC-AUDIT.md`, 2026-07-19, 6 agentes) concluiu que o problema
não é falta de conteúdo (233 `.md`, README de 87KB) mas sim: **(1) sem índice** — o README só linka 9 de
35 ficheiros de `docs/` (26 órfãos); **(2) ~88 endpoints HTTP sem qualquer documentação**; **(3)** todo o
subsistema de **integrações** (Moloni/pagamentos/agenda) vive só em `.claude/plans/` + comentários de
código; **(4) drift** concentrado nas zonas de maior churn. O código mexe ~2× mais que os docs.

**Objetivo.** Um **corpus de conhecimento único** que sirva quatro consumidores da mesma fonte Markdown:
humanos (site React em `/docs/`), autores (vault Obsidian), **agentes** (MCP+RAG — conhecimento partilhado
humano↔agente), e exploração (Open Notebook em `/notebook/`). Servido em `netprospect.netmaster.pt`.

**Decisões fechadas (utilizador):**
- **Site `/docs/`:** **Vite + React + Storybook** à medida; **Docusaurus 3** como spike/opção paralela sobre o mesmo corpus.
- **`/notebook/`:** **Open Notebook** (NotebookLM self-hosted, lfnovo).
- **Acesso:** **interno agora**, arquitetado para poder ir a **público** depois.
- **Camada de conhecimento:** **OKF→Diátaxis** + schema de frontmatter (opc. JSON-LD/schema.org);
  **Graphify→** grafo de wikilinks (react-force-graph, Neo4j opcional); **Context-Mode→** servidor **MCP** + **RAG**.
- **Reverse-proxy:** **NPMplus em hel1-npm**.

## Factos de infra (confirmados live, read-only)

| Facto | Valor | Implicação |
|---|---|---|
| **NPMplus** | `hel1-npm` tailnet `100.89.244.50` / LAN `10.10.10.5`; stack em `/opt/npmplus` **fora do repo** | novas rotas configuram-se **na box** (não no git) → precisa runbook |
| **Auth** | **Authentik forward-auth** (outpost `auth.netmaster.pt`); Access Lists vazias (sem basic-auth) | reutilizar Authentik p/ `/docs/` e `/notebook/` — "de graça" |
| **Exposição atual** | `netprospect.netmaster.pt → 100.114.17.74:3001` (dashboard) **atrás de Authentik**; padrão é **subdomínio** `X.netmaster.pt` | path-based (`/docs/`) exige **custom locations** no proxy host existente |
| **Já expostos** | `ollama.netmaster.pt`, `openwebui.netmaster.pt`, `storybook.*→hel1-docker` (Authentik) | há precedente de Storybook e de UI de IA na frota |
| **np-server** | `100.114.17.74`; corre directus, dashboard, nats, redis, jaeger, adminer, crons, **documenso+postgres** | **Documenso** = precedente literal "web app + DB próprio" em `deploy/server/docker-compose.yml:260-311` |
| **Auto-deploy** | `deploy/agent/pull-deploy.sh`; `agent.env` por host; **guarda: commits só-`.md` NÃO recriam** (`:49-53`) | o build do site precisa de trigger próprio |
| **pgvector** | np-db (Postgres 16 **nativo** em CT, `100.77.60.44`) — **não instalado nem disponível** (só `plpgsql`) | evitar tocar na DB crítica → **Qdrant** isolado |
| **Ollama** | `100.126.196.112:11434`, tailnet, sem auth; **só `gemma3:4b`** (sem modelo de embedding) | é preciso `ollama pull nomic-embed-text` |
| **Dashboard auth** | **nenhuma** — "corre atrás do Authentik/npmPlus" (`dashboard/server.mjs:1-3`) | nada de app para reutilizar; usar Authentik |

## Decisões de desenho (com racional)

1. **Routing por *path* + Authentik.** Adicionar **custom locations** `/docs/` e `/notebook/` ao proxy host
   `netprospect.netmaster.pt` no NPMplus (o `/` continua a ir para o dashboard). Herda o Authentik existente.
   *Fallback:* se o Open Notebook não suportar subpath limpo, `notebook.netprospect.netmaster.pt` (na mesma
   com Authentik). O **MCP nunca passa pelo NPMplus** — só tailnet.
2. **Vector store = Qdrant (container isolado)**, não pgvector. Racional: o np-db é o gargalo de escrita
   ("under pressure"); pgvector nem está disponível e adicionar carga vetorial à DB crítica é risco. Qdrant
   é self-contained, zero alterações ao CT da DB. *(pgvector-no-np-db fica como alternativa se preferires consolidar.)*
3. **Estáticos servidos por `nginx:alpine`** (não existe servidor de estáticos no repo; o Express do dashboard
   é o único hoje). Build do Vite → volume → nginx. **Trigger de rebuild:** systemd timer no host (git pull +
   `docs:build`) — contorna a guarda "só-`.md` não recria".
4. **Embeddings:** `nomic-embed-text` (768-dim) no hel1-ollama. *(bge-m3/mxbai como upgrade de qualidade.)*
5. **Colocação:** estáticos + MCP + ingestão + Qdrant no **np-server** (leves; padrão Documenso); **Open
   Notebook** no np-server ou CT dedicado pequeno se a RAM apertar. Embeddings reutilizam **hel1-ollama**.
6. **Auth = Authentik** para `/docs/` e `/notebook/`; **`/notebook/` NUNCA aberto**. Docs-públicos-futuro:
   gate por `visibility:` no frontmatter (os runbooks têm IPs de tailnet — separar interno de público).

## Arquitetura — "um corpus, várias superfícies"

```
Obsidian (autoria + grafo)  ─edit─┐
lib|worker|dashboard ─jsdoc2md─►  docs/reference/api/   │
server.mjs (rotas)  ─swagger-jsdoc─► openapi.json ──────┤
                                                        ▼
                     docs/  (Diátaxis · frontmatter · [[wikilinks]] · visibility:)
                                                        │
   ┌──────────────┬───────────────┬────────────────────┼──────────────────┐
   ▼              ▼               ▼                     ▼                  ▼
 /docs/         Storybook      Grafo (Graphify)     MCP + RAG           /notebook/
 Vite+React     componentes    graph.json →         (Context-Mode)      Open Notebook
 nginx:alpine   /docs/storybook react-force-graph   Ollama→Qdrant       RAG s/ docs+dados
 Pagefind+RAG                   (+Neo4j opc.)        servidor MCP        (Authentik)
      └──────────────── todos atrás de NPMplus+Authentik ────────┘   (MCP = só tailnet)
```

## Fases

### Fase 0 — Fundação do corpus *(S)*
- Adotar **Diátaxis** (tutorial/how-to/reference/explanation); definir **schema de frontmatter**
  (`title, type, tags, related, owner, status, updated, visibility`) → `docs/CONTRIBUTING.md` (NOVO).
- Converter `docs/` em vault Obsidian (frontmatter + `[[wikilinks]]`); `.obsidian/` no repo.
- **`docs/README.md` (NOVO) = índice** → resolve os 26 órfãos da DOC-AUDIT.

### Fase 1 — Pipeline código→docs *(M)*
- `jsdoc-to-markdown` sobre `lib/`,`worker/`,`dashboard/` → `docs/reference/api/` (script `docs:api`).
- Anotar rotas de `dashboard/server.mjs` com JSDoc `@openapi`; `swagger-jsdoc` → `openapi.json`; render
  **Scalar/Stoplight Elements**. **Fecha o gap #1 da auditoria (~88 rotas).**

### Fase 2 — Site Vite+React em `/docs/` *(L)*
- App Vite+React em **`docs-site/` (NOVO)**: `@mdx-js/rollup` + `remark-obsidian` (wikilinks/callouts) +
  `rehype-pretty-code`; routing sobre a árvore `docs/`; **Pagefind** (keyword) + hook p/ RAG (semântico);
  `base:'/docs/'`; SSG via `vite-react-ssg` (pré-render p/ público-futuro).
- **`deploy/docs/docker-compose.yml` (NOVO)**: `docs-web` (`nginx:alpine`, volume do build), portas em
  `${LAN_IP}/${TAILNET_IP}/127.0.0.1` (padrão da frota).
- Trigger de build (systemd timer: git pull → `docs:build`).

### Fase 3 — Storybook *(M)*
- Storybook 8 (`@storybook/react-vite`) em `docs-site/`; stories dos componentes do site (+ oportunidade:
  importar os do dashboard). Build estático servido em `/docs/storybook/`. *(Reconciliar com o `storybook.*` já existente.)*

### Fase 4 — Grafo (Graphify) *(M)*
- Script `docs:graph` (parse wikilinks/frontmatter → `graph.json`); página "Graph" com `react-force-graph-2d`.
- (Opcional) Neo4j p/ queries ricas (backlinks, caminhos, clusters).

### Fase 5 — Context-Mode (MCP + RAG) *(L)*
- **Qdrant** (container). `ollama pull nomic-embed-text` no hel1-ollama.
- **`kb-ingest` (NOVO, Node)**: watch `docs/` → chunk → embeddings (Ollama) → Qdrant.
- **`kb-mcp` (NOVO, Node, `@modelcontextprotocol/sdk`)**: tools `search_docs / get_doc / list_related /
  graph_neighbors`; exposto **só em `${TAILNET_IP}`**. Ligar no config MCP do Claude Code + agentes do projeto.
- Endpoint `/api/kb/search` (busca semântica do site) servido pelo mesmo serviço.

### Fase 6 — Open Notebook em `/notebook/` *(M)*
- Container Open Notebook (+ DB próprio) no `deploy/docs/`; modelos via Ollama (gemma3:4b + embed) ou cloud;
  ingest do vault + fontes read-only (Postgres read-only, MinIO). **Atrás de Authentik**; rota `/notebook/`.

### Fase 7 — Proxy & runbook *(S)*
- **`docs/runbook-npm-hel1.md` (NOVO)** — documenta o NPMplus (proxy hosts, Authentik) e as **custom
  locations** novas (`/docs/`, `/notebook/`). Preenche o gap "hel1-npm sem runbook" da auditoria.
- Aplicar as custom locations na box hel1-npm (`/opt/npmplus`) — passo manual, capturado no runbook.

## Ficheiros a criar/modificar (representativo)

- **`docs-site/`** (NOVO) — app Vite+React+Storybook + scripts `docs:api|openapi|graph|build`, `storybook:build`.
- **`deploy/docs/docker-compose.yml`** + **`deploy/docs/agent.env.example`** (NOVO) — `docs-web`, `kb-mcp`,
  `kb-ingest`, `qdrant`, `open-notebook`; padrão de portas/`env_file` copiado de `deploy/server/docker-compose.yml:260-311`.
- **`lib/kb/`** (NOVO) — ingestão/embeddings/cliente Qdrant (Node, reutiliza `lib/ollama.js` + acrescenta `/api/embeddings`).
- **`docs/README.md`, `docs/CONTRIBUTING.md`** (NOVO) — índice + schema/Diátaxis.
- **`docs/reference/api/`, `openapi.json`** (GERADOS no build).
- **`docs/runbook-npm-hel1.md`** (NOVO).
- **`dashboard/server.mjs`** — anotações JSDoc `@openapi` nas rotas (aditivo, não altera comportamento).
- **Infra (fora do repo):** `ollama pull nomic-embed-text` (hel1-ollama); custom locations no NPMplus (hel1-npm);
  `agent.env` do novo host/serviço no store da frota.

## Segurança
- **Interno agora:** default = Authentik em todas as rotas (como `netprospect.netmaster.pt` já tem), ou
  tailnet-only via Tailscale Serve. **`/notebook/` nunca aberto.** **MCP só tailnet.**
- **Público-futuro:** SSG pré-renderiza; gate `visibility: internal|public` no frontmatter → o build separa
  o bundle público do interno (não vazar IPs de tailnet/segredos dos runbooks).
- **Open Notebook + "todos os dados":** começar com fontes **read-only** e scope explícito; nunca escrita.

## Ligação à DOC-AUDIT.md
A plataforma é o **veículo** para fechar a auditoria: índice (F0), API docs (F1), navegação Diátaxis (F0/F2).
As correções de drift P1 (Reacher, roles §4, runbooks server-hel1/analytics-de) entram **como conteúdo do
novo corpus**, não em paralelo. O corpus único + pipeline JSDoc/OpenAPI tornam o drift futuro visível (CI pode
falhar se um símbolo documentado desaparecer).

## Riscos & pré-requisitos
- **NPMplus fora do git** → as rotas são passo manual na box; mitigar com o runbook (F7) + snippet versionado.
- **Open Notebook subpath** pode não suportar `/notebook/` limpo → fallback subdomínio (na mesma Authentik).
- **Vite+React à medida = mais trabalho** que Docusaurus → manter Docusaurus 3 como spike de fallback (corpus é portável).
- **Ollama sem embed model / Qdrant novo** → 2 pré-requisitos de infra explícitos (pull + container).
- **Guarda docs-only do auto-deploy** → o site precisa de trigger de rebuild próprio (timer).
- **Segredos/IPs nos runbooks** → gate `visibility:` antes de qualquer exposição pública.

## Verificação (end-to-end)
1. **Corpus/índice** — abrir o vault no Obsidian: grafo liga, `docs/README.md` indexa tudo, wikilinks resolvem.
2. **API gerada** — `npm run docs:api && npm run docs:openapi` produz `docs/reference/api/*` e `openapi.json` sem erros; Scalar renderiza as ~88 rotas.
3. **Site** — `npm run docs:build` → `docker compose -f deploy/docs/docker-compose.yml up -d docs-web`; `curl -sI https://netprospect.netmaster.pt/docs/` = `200` (após Authentik) e assets resolvem sob `/docs/`.
4. **Storybook** — `https://netprospect.netmaster.pt/docs/storybook/` carrega os componentes.
5. **Grafo** — a página Graph mostra os nós/arestas do `graph.json`.
6. **RAG/MCP** — `ollama pull nomic-embed-text`; ingestão popula o Qdrant; no Claude Code, o tool `search_docs("reacher blocklist")` devolve o doc certo; `/api/kb/search` devolve resultados semânticos.
7. **Notebook** — `https://netprospect.netmaster.pt/notebook/` (atrás de Authentik) chateia sobre um doc ingerido; `curl` sem sessão Authentik → `302` para `auth.netmaster.pt` (nunca aberto).
8. **Auth** — todas as rotas exigem Authentik; o MCP só responde na tailnet (falha do exterior).

## Esforço (relativo)
F0 **S** · F1 **M** · F2 **L** · F3 **M** · F4 **M** · F5 **L** · F6 **M** · F7 **S**. Caminho de valor
mínimo se quiseres fatiar: **F0 + F1 + F2** (corpus + API + site) já entrega o site de docs e fecha os
maiores gaps da auditoria; F5 (agentes) e F6 (notebook) são as camadas de conhecimento por cima.

---

## Fase 9 — UX redesign + Grafo com chat AI (2026-07-20)

Pedido do user. **Ordem: design primeiro (F9a), depois o chat do grafo (F9b).**

### F9a — Design pixel-perfect (reimplementar em componentes React)
- Recriar o design-system do dashboard base (`dashboard/public/index.html`, vars `np-*`) como **componentes
  React** no `docs-site` (NÃO partilhar o CSS) — documentados no **Storybook**. Shell completo: sidebar
  colapsável (grupos como o nav do dashboard), topbar, **temas claro/escuro**, chips/cards/botões/tabelas.
- Aplicar ao site de docs (App.jsx passa a usar o shell/componentes novos). Diátaxis → grupos colapsáveis.

### F9b — Grafo: chat AI + escalar p/ Notebook + back-links
- **Chat sobre o grafo** (estilo search assistida por AI): pergunta → RAG (kb-http) + resposta AI + destaque
  no grafo. Respostas com **citações que linkam de volta às páginas dos docs** (`/docs/#/<slug>`).
- **Backend multi-modelo** (a construir):
  - **Retrieval = default base** (só RAG, sem geração).
  - **Ollama** corre se a **feature-flag NÃO estiver off** (controlada por **env var + PostHog feature flag**).
  - **Providers externos via CLI-em-container-Docker** (Claude Code CLI, Codex CLI, Cursor CLI, Gemini CLI) —
    **se houver API keys, tomam PRECEDÊNCIA** sobre o Ollama.
  - **O user ESCOLHE o modelo** na UI (picker) para a pesquisa/conversa com os agentes.
- **Escalar p/ Notebook:** botão "continuar no assistente do Notebook" passando o contexto (Q&A + graph calls);
  **investigar a API do Open Notebook (:5055)** e propor o handoff (criar notebook semeado vs pré-preencher).
