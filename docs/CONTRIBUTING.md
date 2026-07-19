---
title: Como escrever docs no NetProspect
type: explanation
tags: [docs, meta, diataxis, obsidian]
related: [[README]]
owner: plataforma
status: living
updated: 2026-07-19
visibility: internal
---

# Como escrever documentação no NetProspect

Este é o **standard** do corpus de docs. Uma só fonte Markdown (`docs/` = vault Obsidian)
alimenta o site React (`/docs/`), o grafo, o RAG dos agentes e o Open Notebook. Ver o plano
em [[docs-plan]] (`.claude/plans/current/docs-plan.md`).

## 1. Diátaxis — a que categoria pertence o teu doc

Todo o doc é **uma** das quatro categorias ([Diátaxis](https://diataxis.fr)):

| `type:` | Orientação | Responde a | Exemplos aqui |
|---|---|---|---|
| **tutorial** | aprendizagem | "ensina-me a começar" | (poucos ainda) |
| **how-to** | tarefa | "como faço X" | os `runbook-*.md`, `outreach-ops/*`, `subdomain-sources-keys.md` |
| **reference** | informação | "quais são os factos/campos" | `comercial/*`, `reference/api/*`, `GMB-README.md`, benchmarks |
| **explanation** | compreensão | "porquê / como funciona" | `README.md`, `distributed-fleet.md`, `stack-isolation.md`, `observability.md` |

Extra (não-Diátaxis, mas úteis): **incident** (post-mortems em `incidents/`), **working** (docs de
trabalho vivos: `TODO.md`, `DEBUGGING-TODO.md`, `DEBUG-FOUND.md`, `DOC-AUDIT.md`).

**Regra:** não misturar categorias no mesmo doc. Um runbook (how-to) não explica arquitetura — linka
para o doc de explanation. Isto mantém cada doc curto e evita o drift.

## 2. Frontmatter obrigatório

Todo o `.md` começa com este bloco YAML (é o que alimenta o índice, o grafo e o RAG):

```yaml
---
title: <título humano>
type: tutorial | how-to | reference | explanation | incident | working
tags: [reacher, verify, infra, ...]      # kebab-case, para busca/grafo
related: [[outro-doc]]                    # wikilinks p/ docs relacionados
owner: <quem mantém>                       # ex.: plataforma, outreach, infra
status: living | stable | historical | draft
updated: YYYY-MM-DD                        # data da última revisão real
visibility: internal | public              # gate p/ exposição pública futura
---
```

- **`visibility: internal`** é o default. Só `public` sai no bundle público do site. Os runbooks têm
  IPs de tailnet/segredos → **ficam sempre `internal`**.
- **`status: historical`** marca docs mantidos por registo (ex.: incidentes fechados, `runbook-analytics-de`).

## 3. Wikilinks e ligações

- Liga docs com **`[[nome-do-ficheiro-sem-extensão]]`** (estilo Obsidian). Ex.: `[[runbook-server-hel1]]`.
- Embeds com `![[doc#secção]]` quando faz sentido reutilizar conteúdo (evita duplicação → evita drift).
- Liga **liberalmente**: o grafo (Graphify) e o RAG (Context-Mode) usam estas arestas para relacionar
  conhecimento entre docs e para os agentes navegarem.

## 4. Callouts (Obsidian)

```
> [!warning] Título
> Corpo do aviso.
```
Suportados: `note`, `tip`, `warning`, `danger`, `info`. Renderizam no site e no Obsidian.

## 5. Regras de higiene (anti-drift)

- **Um facto, um sítio.** Se um IP/porta/comando aparece em 3 docs, é candidato a `![[embed]]` de um só.
- **API e rotas HTTP são geradas**, não escritas à mão: `docs/reference/api/` vem de `jsdoc-to-markdown`
  e `openapi.json` vem das anotações `@openapi` em `dashboard/server.mjs`. Não editar os ficheiros gerados.
- **Ao mover/renomear**, atualizar os `[[wikilinks]]` (o Obsidian fá-lo automaticamente).
- **`updated:`** reflete a última revisão *real* do conteúdo, não um toque cosmético.
- Novos docs entram **sempre** no índice [[README]] (secção da categoria certa).

## 6. Onde é que cada coisa vive

- `docs/` — o corpus (este vault). `docs/reference/api/` — gerado. `docs/incidents/` — post-mortems.
- `.claude/plans/current/` — planos ativos (não são docs de uso; são planos).
- Raiz do repo — `README.md` (overview mestre), e docs de trabalho (`TODO.md`, etc.).
