# deploy/docs — Plataforma de Documentação & Conhecimento

Serve `netprospect.netmaster.pt/docs/` (e, nas fases seguintes, `/notebook/` + o MCP). Plano completo:
`.claude/plans/current/docs-plan.md`.

## Serviços (compose)
- **`docs-web`** (F2) — `nginx:alpine` que serve o build estático `docs-site/dist` na porta `8088`.
- **`qdrant`** (F5) — vector store (porta `6333`, tailnet-only).
- **`kb-http`** (F5) — API de busca semântica: `POST/GET /search`, `/doc`, `/related` (porta `8099`, tailnet-only).
- **`kb-ingest`** (F5, profile `ingest`) — one-shot que embebe o corpus no Qdrant.
- *(F6)* `open-notebook` — NotebookLM self-hosted em `/notebook/`.

## Context-Mode (RAG + MCP) — F5
1. **Embeddings**: **in-process** via transformers.js (ONNX, multilingue) — **não precisa do Ollama**. Modelo
   `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim), descarrega 1× para o volume `hf-cache`. ~8ms/texto.
2. **Subir** o Qdrant + a API: `docker compose -p npdocs -f deploy/docs/docker-compose.yml up -d qdrant kb-http`.
3. **Ingerir** (após cada rebuild do conteúdo): `docker compose -p npdocs -f deploy/docs/docker-compose.yml run --rm kb-ingest`.
4. **Agentes** (Claude Code): o `.mcp.json` na raiz liga o servidor MCP `netprospect-kb` (tools `search_docs`,
   `get_doc`, `list_related`). Corre via `node docs-site/mcp/stdio.mjs` e usa o mesmo Qdrant/Ollama.
5. **Site**: a busca semântica chama `kb-http` `/search` (o NPMplus mapeia `/api/kb/` → `kb-http:8099`).

> [!note] Backend de embeddings
> Default `KB_EMBED_BACKEND=local` (transformers.js/ONNX, multilingue, ~300× mais rápido que o Ollama CPU
> do hel1). Alternativa `KB_EMBED_BACKEND=ollama` (usa `OLLAMA_URL` + `KB_EMBED_MODEL`, ex.: `all-minilm`) —
> mantida mas lenta (~2.6s/embed). O `onnxruntime-node` (nativo) é usado do `docs-site/node_modules`
> construído no host → precisa de linux-x64/glibc (= `node:20-slim`); se não bater, correr `npm ci` no container.
> Relevância PT boa nos testes (reacher/clickhouse/subdomínios no ponto); tabelas terse (http-api) embebem
> pior — melhorável enriquecendo os chunks. `paraphrase-multilingual-MiniLM` = 384-dim.

## Como correr (np-server)
```bash
# 1) construir o site a partir do vault (gera docs-site/dist)
bash deploy/docs/build.sh
# 2) subir o nginx
docker compose -p npdocs -f deploy/docs/docker-compose.yml up -d docs-web
```

## Rebuild do conteúdo (importante)
O `dist/` **não** é versionado (gitignored). A guarda do `deploy/agent/pull-deploy.sh` **não recria**
containers em commits só-`.md`, mas o site TEM de ser reconstruído quando `docs/` muda. Solução: um
**systemd timer** que corre `deploy/docs/build.sh` após o pull. Instalar no np-server:

```ini
# ~/.config/systemd/user/npdocs-build.service   (Type=oneshot, ExecStart=.../deploy/docs/build.sh)
# ~/.config/systemd/user/npdocs-build.timer      (OnUnitActiveSec=10min, Persistent=true)
```
O `nginx` serve o `dist` novo sem recreate (é um bind-mount read-only).

## Rota no NPMplus (hel1-npm) — ver runbook (F7)
Adicionar uma **custom location** ao proxy host `netprospect.netmaster.pt` (que já vai para o dashboard):
```nginx
location /docs/ {
    proxy_pass http://<np-server-tailnet-ip>:8088/;   # trailing slash → tira o /docs/
    proxy_set_header Host $host;
}
```
Herda o Authentik do proxy host (interno). O `docs-web` serve na raiz; o HTML tem `base=/docs/`.

## Ver localmente (dev)
```bash
cd docs-site && npm install && npm run dev      # http://localhost:5173/docs/
# ou o build de produção:  npm run build && npm run preview
```
