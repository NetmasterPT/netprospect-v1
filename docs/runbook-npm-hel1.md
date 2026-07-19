---
title: "Runbook — NPMplus (reverse-proxy) em hel1-npm"
type: how-to
tags: [infra, npm, proxy, authentik, runbook]
related: [[distributed-fleet]]
owner: infra
status: stable
updated: 2026-07-19
visibility: internal
---

# Runbook — NPMplus (reverse-proxy) em hel1-npm

O **NPMplus** (fork do Nginx Proxy Manager) é o **único reverse-proxy** da frota: termina TLS e faz proxy
de tudo em `*.netmaster.pt`. Corre em **`hel1-npm`** (tailnet `100.89.244.50`, LAN `10.10.10.5`), via
docker-compose em **`/opt/npmplus`** (fora do git). A stack inclui **Authentik** (SSO/OIDC forward-auth),
o WAF **openappsec**, **crowdsec** e **tailscale**.

## Modelo
- **Padrão = subdomínio:** cada serviço é um *proxy host* `X.netmaster.pt` → backend na tailnet.
- **Auth = Authentik forward-auth** (outpost `auth.netmaster.pt`). As Access Lists do NPMplus não são usadas.
- Exemplos vivos: `netprospect.netmaster.pt → 100.114.17.74:3001` (dashboard, **Authentik**),
  `ollama.netmaster.pt`, `openwebui.netmaster.pt`, `storybook.*`, `grafana/prometheus/…`.

## Plataforma de docs — rotas por *path* em `netprospect.netmaster.pt`
Os docs vivem sob `/docs/` (e, na F6, `/notebook/`) do proxy host **existente** `netprospect.netmaster.pt`
(que já vai para o dashboard e já tem Authentik). Como o NPMplus não expõe as portas por path na UI base,
adicionar via **Advanced → Custom Nginx Configuration** desse proxy host:

```nginx
# Site de docs (F2) — o docs-web (nginx) serve na raiz; o trailing slash tira o /docs/.
location /docs/ {
    proxy_pass http://100.114.17.74:8088/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# (F6) Open Notebook — se não suportar subpath limpo, usar antes um subdomínio notebook.netmaster.pt.
# location /notebook/ { proxy_pass http://100.114.17.74:8090/; proxy_set_header Host $host; }

# (opcional) API de busca semântica p/ o site — kb-http. O prefixo /api/kb/ é mais específico que a / do
# dashboard, por isso não colide. Deixar comentado até o site usar busca semântica (hoje é client-side).
# location /api/kb/ { proxy_pass http://100.114.17.74:8099/; proxy_set_header Host $host; }
```

O `/` continua a ir para o dashboard; só `/docs/…` é desviado. **Herda o Authentik** do proxy host (interno).

## Como aplicar (na box hel1-npm)
1. UI do NPMplus (`npm.netmaster.pt`) → Proxy Hosts → `netprospect.netmaster.pt` → **Edit** → aba **Advanced**.
2. Colar o bloco acima em *Custom Nginx Configuration* → **Save** (o NPMplus regenera + recarrega o nginx).
3. Validar: `curl -sI https://netprospect.netmaster.pt/docs/` → `302` para `auth.netmaster.pt` (Authentik) e,
   após login, `200`. Os assets pedem `/docs/assets/*` (o HTML tem `base=/docs/`).

> [!warning] Config fora do git
> O `/opt/npmplus` (e estas custom locations) vivem **na box**, não no repo. Guardar aqui o snippet como
> fonte de verdade e re-aplicar se a box for reprovisionada. **Nunca** editar os ficheiros gerados do nginx
> à mão (o NPMplus sobrepõe-nos) — usar sempre a UI.

## Backends da plataforma (np-server, `100.114.17.74`, tailnet)
- `:8088` docs-web (site) · `:8099` kb-http (busca) · `:6333` qdrant · *(F6)* `:8090` open-notebook.
- `qdrant`/`kb-http` ficam **tailnet-only** (os agentes usam o Qdrant direto; o MCP é stdio). Só o `/docs/`
  (e o `/notebook/`) passam pelo NPMplus.
