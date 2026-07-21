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
de tudo em `*.netmaster.pt`. Corre em **`hel1-npm`** (`npm.netmaster.pt`, tailnet `100.89.244.50`, LAN
`10.10.10.5`) — **Proxmox hel1-pve, CT VMID 103, Alpine** — via `docker compose` a partir de
**`/opt/compose.yaml`**. A stack inclui **Authentik** (SSO/OIDC forward-auth), o WAF **openappsec**,
**crowdsec** e **tailscale**.

> [!note] Deploy agora é gitops (desde 2026-07-21)
> O `/opt/compose.yaml` é **gerido por git** — vem de [`deploy/npmplus/`](../deploy/npmplus/) (compose
> parametrizado; os 7 segredos externalizados via `${VAR}`). Um **cron `*/5`** na box corre
> `deploy/npmplus/deploy.sh`: `git pull` → se `deploy/npmplus/` mudou, valida + `docker compose up -d`
> (SEM `--force-recreate` → sem downtime). Os **segredos vivem em `/opt/.env`** (fora do git, nunca saem
> da box). Ver o [README do deploy](../deploy/npmplus/README.md).

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
# Site de docs (F2) — o docs-web (nginx) serve SOB /docs/ (o site tem base=/docs/).
# proxy_pass SEM barra final → o /docs/ passa intacto (não fazer strip, senão os assets 404).
location /docs/ {
    proxy_pass http://100.114.17.74:8088;
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

> [!warning] Duas camadas — só a A está no git
> **Camada A (motor/global):** TLS/ACME, portas, OIDC, segredos, WAF — no `compose.yaml` (git) + `/opt/.env`
> (box). Alterar = editar `deploy/npmplus/compose.yaml`, commit → o cron `*/5` aplica.
> **Camada B (routing):** proxy hosts, estas custom locations, certs e access-lists vivem **na DB do NPMplus**
> (`/opt/npmplus/npmplus/database.sqlite` + `/opt/npmplus/custom_nginx/`) — **não** são declaráveis por env;
> gerem-se pela **UI/API** e reproduzem-se pelo backup do CT (vzdump). Guardar aqui os snippets como fonte de
> verdade. **Nunca** editar os ficheiros gerados do nginx à mão (o NPMplus sobrepõe-nos) — usar sempre a UI.

## Backup / rollback (antes de mexer no deploy)
- **Ficheiros:** `ssh root@100.89.244.50 'tar czf /root/npmplus-<ts>.tar.gz -C /opt --exclude=./authentik/postgres --exclude=./openappsec/pgdb .'` (Camada A+B).
- **CT completo (hel1-pve):** `vzdump 103 --mode snapshot --storage pbs-local --notes-template "<nota>"` (ZFS = sem downtime).
- **Rollback do compose:** `cp /opt/compose.yaml.bak /opt/compose.yaml && docker compose --project-directory /opt -f /opt/compose.yaml --env-file /opt/.env up -d`.
- **Rollback total:** restaurar o CT 103 do PBS (`pbs-local`).

## Backends da plataforma (np-server, `100.114.17.74`, tailnet)
- `:8088` docs-web (site) · `:8099` kb-http (busca) · `:6333` qdrant · *(F6)* `:8090` open-notebook.
- `qdrant`/`kb-http` ficam **tailnet-only** (os agentes usam o Qdrant direto; o MCP é stdio). Só o `/docs/`
  (e o `/notebook/`) passam pelo NPMplus.
