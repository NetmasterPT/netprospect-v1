# deploy/docs — Plataforma de Documentação & Conhecimento

Serve `netprospect.netmaster.pt/docs/` (e, nas fases seguintes, `/notebook/` + o MCP). Plano completo:
`.claude/plans/current/docs-plan.md`.

## Serviços (compose)
- **`docs-web`** (F2) — `nginx:alpine` que serve o build estático `docs-site/dist` na porta `8088`.
- *(F5)* `qdrant`, `kb-ingest`, `kb-mcp` — RAG + servidor MCP (tailnet-only).
- *(F6)* `open-notebook` — NotebookLM self-hosted em `/notebook/`.

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
