---
title: "Máquina — NPMplus reverse-proxy (hel1-npm, VM 103)"
type: reference
tags: [infra, npm, proxy, authentik, openappsec, crowdsec, runbook, machine]
related: [[distributed-fleet]]
owner: infra
status: stable
updated: 2026-07-24
visibility: internal
---

# hel1-npm — reverse-proxy da plataforma (NPMplus + Authentik + openappsec + crowdsec)

Documento **específico desta máquina**: o único reverse-proxy da frota. Termina TLS e faz proxy de **tudo o que é
`*.netmaster.pt`** para os backends na tailnet. Ver também [deploy/npmplus/README.md](../deploy/npmplus/README.md) e
[docs/auth-npmplus-authentik.md](auth-npmplus-authentik.md).

> **Migrado de CT LXC (Alpine) → VM Debian/Docker em 2026-07-24** (o README oficial do NPMplus desrecomenda LXC), no
> mesmo passo que o upgrade da imagem para `2026-07-24-r1`. **VMID 103, hostname e LAN IP preservados.** Detalhe do
> cutover na memória `npmplus-gitops-deploy`.

## Identidade da máquina

| | |
|---|---|
| **Papel** | Reverse-proxy único de `*.netmaster.pt` (TLS + Authentik forward-auth + WAF) |
| **Servidor físico** | **hel1-pve** (Proxmox), **Hetzner — Helsínquia, Finlândia** 🇫🇮 |
| **Tipo / ID** | **VM KVM, VMID 103** (Debian 13 + Docker) — era CT LXC Alpine até 2026-07-24 |
| **Hostname** | `npm.netmaster.pt` (hostname do guest: definido; tailnet: `npm-hel1`) |
| **LAN (vmbr1)** | **`10.10.10.5/24`** (gw `10.10.10.1` = hel1-pve) — *preservado na migração* |
| **Tailnet** | `100.119.63.18` (⚠️ mudou de `100.89.244.50` no cutover — re-registo do nó; ver obs) |
| **IP público** | **`65.108.120.25`** (Hetzner) — via **DNAT no hel1-pve**: `80/443/81 → 10.10.10.5` |
| **Recursos** | 4 vCPU / 6 GB RAM / 32 GB disco (local-zfs) |
| **Gestão do compose** | `docker compose` de `/opt/compose.yaml` (gerado do git — ver Gitops) |

## Acesso

- **SSH:** não há `:22` público (só 80/443/81 são DNAT'd). Acesso via **jump pelo hel1-pve**:
  `ssh -J root@<hel1-pve-tailnet> root@10.10.10.5` (chaves `netprospect-apphost` + `root@pve` injetadas no cloud-init).
  Também por **Tailscale SSH** (o container tailscale corre `--ssh`).
- **Painel admin NPMplus:** `https://npm.netmaster.pt` → **login por OIDC (Authentik)**. O `/api` está **fechado**
  ao público (só localhost + tailnet; externo → 403).
- **Authentik admin:** `https://auth.netmaster.pt/if/admin/`.

## Credenciais — ONDE estão (nunca no git)

Todos os segredos vivem em **`/opt/.env`** (perms 600, fora do git, nunca saem da box). O compose lê-os via `${VAR}`:

| Var | Para quê |
|---|---|
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | login OIDC do painel NPMplus (via Authentik) |
| `AUTHENTIK_PG_PASSWORD` / `AUTHENTIK_SECRET_KEY` | Authentik (postgres + chave da app) |
| `OPENAPPSEC_DB_PASSWORD` | postgres do openappsec |
| `CROWDSEC_LAPI_KEY` | LAPI do crowdsec |
| `TS_AUTHKEY` | auth key da Tailscale (⚠️ **expirada** — re-auth do nó faz-se por login URL, ver obs) |
| `NPMPLUS_API_EMAIL` / `NPMPLUS_API_PASSWORD` | user LOCAL admin do NPM p/ a API (**`gpedro@netmaster.pt`**) |

- **User admin local do NPMplus:** `gpedro@netmaster.pt` (a password é a `NPMPLUS_API_PASSWORD`). Reset:
  `docker exec npmplus password-reset.js <email> <pass>`.
- **NUNCA** meter segredos no git nem imprimi-los. Backup do `/opt/.env` só dentro do vzdump do CT/VM.

## Portas

| Porta | Bind | Exposição | Serviço |
|---|---|---|---|
| **443** | todas | **pública** (DNAT) | HTTPS proxy (+ HTTP/3 UDP) |
| **80** | todas | **pública** (DNAT) | HTTP (redirect + ACME challenge) |
| **81** | todas | **tailnet/LAN** (não pública) | **admin backend NPMplus** — a DNAT pública da :81 foi removida (2026-07-24); admin só por VPN/tailnet |
| 9100 | todas | tailnet | node-exporter (Prometheus) |
| 8098 | tailnet IP | tailnet | cadvisor (Prometheus) |
| 9000 / 9443 | `127.0.0.1` | local | Authentik server (o npmplus faz proxy p/ localhost) |

> ✅ **Segurança (resolvido 2026-07-24):** a `:81` (admin) já **não** está exposta ao público — removida a regra DNAT
> `65.108.120.25:81 → 10.10.10.5:81` no hel1-pve (`/etc/network/interfaces`, só as linhas `--dport 81`; 80/443
> intactas). O admin continua acessível pela **Tailnet** (`100.119.63.18:81`) e pelo painel OIDC (443).

## Endpoints de API

- **NPMplus API:** `https://npm.netmaster.pt/api` — **fechado** ao público (allow `127.0.0.1`, `::1`,
  `100.64.0.0/10`, `fd7a:115c:a1e0::/48`; externo → 403). Auth: `POST /api/tokens` (user local → JWT em **cookie**,
  Bearer não funciona) com header `Host: npm.netmaster.pt`. Gestão dos proxy hosts também via
  [`deploy/npmplus/npmplus-routes.*`](../deploy/npmplus/) (método `api` por default).
- **Authentik API:** `https://auth.netmaster.pt/api/v3/` (schema em `/api/v3/schema/`; auth por token de service
  account). Os paths OIDC (`/application/o/`) e forward-auth (`/outpost.goauthentik.io/`) TÊM de ser públicos.

## Stack (containers)

`npmplus` (host-net) · `authentik-{postgres,redis,server,worker}` · `openappsec-{agent,smartsync,shared-storage,`
`tuning-svc,db}` (WAF) · `crowdsec` (host-net) · `tailscale` (host-net) — **12 containers** do compose. Mais, fora do
compose: `cadvisor` (container) + `node_exporter`/`alloy`/`netprospect-metrics` (systemd).

- **Modelo de routing:** cada serviço é um *proxy host* `X.netmaster.pt` → backend na tailnet. **Auth = Authentik
  forward-auth** via embedded outpost (`/outpost.goauthentik.io/`). Ex.: `netprospect.netmaster.pt → 100.114.17.74:3001`.

## Gitops (auto-deploy por PULL)

- Repo em **`/opt/netprospect-v1`**; cron **`*/5`** em `/etc/cron.d/npmplus-deploy` → `deploy/npmplus/deploy.sh`:
  `git pull` → se `deploy/npmplus/` mudou, valida + `docker compose up -d` (recria só o serviço cujo config mudou;
  aborta sem derrubar o proxy se o compose for inválido). **Verificado E2E:** um commit → a VM faz pull + rebuild do
  container.
- **Duas camadas:** **A (motor)** = `compose.yaml` (git) + `/opt/.env` (box). **B (routing)** = proxy hosts / custom
  nginx / certs → **DB SQLite** `/opt/npmplus/npmplus/database.sqlite`, versionada em
  [`deploy/npmplus/routes.json`](../deploy/npmplus/routes.json) (`npmplus-routes` sync, método `api` default).
- **Guardrail:** sync auto só **main → box**; export (box → main) é sempre **manual, validado por humano**.

## Observabilidade

- **Prometheus** (CT200): scrape de `100.119.63.18:9100` (node) + `:8098` (cadvisor). Aplicar mudanças via
  `deploy/observability/push-configs.sh --only prometheus`.
- **Logs → Loki** (`100.95.20.65:3100`) via **Alloy** (journald + docker logs), label `host=hel1-npm`.
- **Página Servidores:** agente `/opt/np/report.sh` (systemd timer `netprospect-metrics`, 5 min) → np-server
  (`100.114.17.74:3001`), chaves `np:host:hel1-npm:*`.

## Backup / rollback

- **VM completa (hel1-pve):** `vzdump 103 --mode snapshot --storage pbs-local` (ZFS = sem downtime).
- **Só `/opt`:** `tar czf … -C /opt .` (Camada A+B; excluir os pgdata se quente).
- **Rollback do compose:** `cp /opt/compose.yaml.bak /opt/compose.yaml && docker compose --project-directory /opt
  -f /opt/compose.yaml --env-file /opt/.env up -d`.
- **Rollback total:** restaurar do PBS (`pbs-local`). *(Existe um vzdump pré-migração do CT LXC.)*

## Links externos (documentação oficial)

- **NPMplus:** <https://github.com/ZoeyVid/NPMplus> (README = referência de env; usa tags de **data**, não semver).
- **Authentik:** <https://docs.goauthentik.io> · API: <https://api.goauthentik.io>.
- **open-appsec (WAF):** <https://docs.openappsec.io>.
- **CrowdSec:** <https://docs.crowdsec.net> · coleção NPMplus: `ZoeyVid/npmplus`.

## Docs-platform — custom locations em `netprospect.netmaster.pt` (Camada B, na UI/API)

Os docs vivem sob `/docs/` do proxy host **existente** `netprospect.netmaster.pt` (já vai p/ o dashboard + Authentik).
Adicionar via **Advanced → Custom Nginx Configuration** desse proxy host (o `/` continua a ir p/ o dashboard):

```nginx
location /docs/ {                       # docs-web (site) — base=/docs/; proxy_pass SEM barra final (não fazer strip)
    proxy_pass http://100.114.17.74:8088;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
# location /notebook/ { proxy_pass http://100.114.17.74:8090/; proxy_set_header Host $host; }   # Open Notebook
# location /api/kb/  { proxy_pass http://100.114.17.74:8099/; proxy_set_header Host $host; }     # busca semântica
```

Validar: `curl -sI https://netprospect.netmaster.pt/docs/` → `302` p/ Authentik e, após login, `200`.
**Nunca** editar os confs gerados do nginx à mão (o NPMplus sobrepõe-nos) — usar a UI/API.
