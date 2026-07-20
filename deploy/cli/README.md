# CLIs de IA em Docker (F2) — providers do chat de docs

Cada provider corre um **CLI de IA dentro de um container** por-pedido (o `kb-http` faz `docker run --rm -i`).
Aparecem no seletor de modelo do chat (`/chat`) e ficam **`available` se tiverem auth** — por **API key** OU
**token de subscrição** (usa a quota do plano via a auth da própria CLI). Registry: `config/cli-providers.json`.
Runner: `docs-site/mcp/cli-providers.mjs`.

## Ativar (3 passos)

1. **Construir a(s) imagem(ns):**
   ```bash
   bash deploy/cli/build.sh                 # constrói todas as que têm Dockerfile
   # ou uma: docker build -t netprospect/claude-cli:latest -f deploy/cli/Dockerfile.claude-cli deploy/cli
   ```
2. **Auth** — pôr a env no `.env` do `kb-http` (dashboard → Servidores → Editar .env, ou `deploy/docs/.env`).
   API key **ou** token de subscrição (basta uma):

   | Provider | API key | Subscrição (quota do plano) | Quota |
   |---|---|---|---|
   | `claude-cli` | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | Pro/Max: msgs por 5h · API pay-per-use |
   | `codex-cli` | `OPENAI_API_KEY` | `CODEX_AUTH_TOKEN` | ChatGPT Plus/Pro · API pay-per-use |
   | `gemini-cli` | `GEMINI_API_KEY` | `GOOGLE_OAUTH_TOKEN` | Code Assist free ~1000/dia · API |
   | `cursor-cli` | `CURSOR_API_KEY` | `CURSOR_TOKEN` | Cursor Pro |
   | `grok-cli` | `XAI_API_KEY` | `GROK_TOKEN` | xAI / X Premium+ |
   | `deepseek-cli` | `DEEPSEEK_API_KEY` | — | pay-per-use |
   | `opencode-cli` | `OPENCODE_API_KEY`/`OPENROUTER_API_KEY` | `OPENCODE_TOKEN` | conforme provider |

3. **Socket Docker no `kb-http`** — o `kb-http` precisa de `docker` (CLI) + acesso ao socket para lançar os
   containers. Em `deploy/docs/docker-compose.yml` (kb-http), descomentar:
   ```yaml
   #   volumes:
   #     - /var/run/docker.sock:/var/run/docker.sock   # F2: kb-http lança os CLIs
   #   # e usar uma imagem com docker-cli (ou instalar docker-cli no arranque)
   ```
   ⚠️ O socket dá acesso ~root ao host — em produção aberta, preferir um **runner dedicado** (sidecar) em vez
   de dar o socket ao `kb-http`.

## Notas
- `promptVia`: `stdin` (default, escreve o prompt no stdin) ou `arg` (substitui/《anexa》o prompt ao comando).
- `-e NOME` (sem valor) reencaminha a env do `kb-http` para o container — por isso a env de auth tem de estar
  no `kb-http`, não só no host.
- Precedência (no chat): o **user escolhe o modelo**; se escolher um CLI provider, corre esse. Sem auth →
  aparece «· sem key» e devolve um aviso.
- `grok-cli`/`deepseek-cli`/`opencode-cli`: adicionar `Dockerfile.<id>` no mesmo padrão quando quiseres usá-los.
