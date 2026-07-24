# deploy/npmplus — reverse-proxy NPMplus (gitops)

O **NPMplus** (fork do Nginx Proxy Manager) é o **único reverse-proxy** da frota: termina TLS e faz
proxy de tudo em `*.netmaster.pt`. Corre no CT **hel1-npm** (`npm.netmaster.pt`, tailnet
`100.89.244.50`, LAN `10.10.10.5`) — **Proxmox hel1-pve, VMID 103**, via `docker compose` a partir de
`/opt/compose.yaml`. A stack: **npmplus + Authentik** (SSO/OIDC + forward-auth) + **openappsec** (WAF) +
**crowdsec** (IPS) + **tailscale**. Ver também [runbook-npm-hel1](../../docs/runbook-npm-hel1.md).

## Duas camadas de configuração (importante)

| Camada | O quê | Onde | Gerido por |
|---|---|---|---|
| **A — motor/global** | TLS/ACME, portas, IPs, OIDC, segredos, WAF, timezone | `compose.yaml` (env vars) + `/opt/.env` | **git** (este dir) |
| **B — routing** | proxy hosts (`X.netmaster.pt → backend`), custom nginx (`advanced_config`), certs, access-lists | DB SQLite `/opt/npmplus/npmplus/database.sqlite` | **UI** do NPMplus **+ git** (`routes.json`) |

**A Camada A** (motor) é declarável por env no `compose.yaml`. **A Camada B** (routing) vive na DB do
NPMplus e continua **editável na UI**, mas está agora **versionada em `routes.json`** e reconciliada com a
DB pelos scripts abaixo (a API é OIDC-gated → escrevemos a DB direto). Nunca editar os ficheiros gerados do
nginx à mão (o NPMplus sobrepõe-nos) — editar na UI **ou** no `routes.json`.

## Como funciona o deploy (PULL)

`deploy.sh` corre por timer na box: `git pull` → se `deploy/npmplus/` mudou, copia `compose.yaml` para
`/opt/compose.yaml`, **valida** (`docker compose config`) e faz `docker compose up -d` (SEM
`--force-recreate` → só recria o serviço cujo config mudou; o resto do proxy fica up, sem downtime). Um
compose inválido ou um segredo em falta **aborta sem derrubar o proxy** (e reverte o `/opt/compose.yaml`).

- **Segredos** (`OIDC_*`, `CROWDSEC_LAPI_KEY`, `TS_AUTHKEY`, `AUTHENTIK_*`, `OPENAPPSEC_DB_PASSWORD`)
  vivem em `/opt/.env` — **fora do git, nunca saem da box**. `compose.yaml` lê-os via `${VAR:?}`.
- Tudo o resto (TZ, ACME_EMAIL, domínios OIDC/Authentik) fica inline no `compose.yaml` (não é segredo).

## Bootstrap (uma vez, na box hel1-npm)

```sh
# 1) clonar o repo
git clone <origin> /opt/netprospect-v1

# 2) criar o /opt/.env com os segredos (valores no backup pré-migração / vzdump)
cp /opt/netprospect-v1/deploy/npmplus/.env.example /opt/.env && vi /opt/.env

# 3) primeira aplicação (manual, para validar)
NPMPLUS_REPO=/opt/netprospect-v1 /opt/netprospect-v1/deploy/npmplus/deploy.sh

# 4) agendar por cron (funciona em Alpine/busybox e Debian) — a cada 5 min
( crontab -l 2>/dev/null; echo "*/5 * * * * NPMPLUS_REPO=/opt/netprospect-v1 /opt/netprospect-v1/deploy/npmplus/deploy.sh" ) | crontab -
# (em hosts com systemd, pode usar-se antes um .timer equivalente)
```

## Versionamento do routing (Camada B) — `routes.json`

Os 35+ proxy hosts estão em **`routes.json`** (export declarativo da DB). O `deploy.sh` aplica-o
automaticamente quando muda num push. Continua tudo **editável na UI** — o modelo é bidirecional:

```sh
# UI → git (capturar edições da UI para versionar): correr numa máquina com push
sh deploy/npmplus/npmplus-routes.sh export > deploy/npmplus/routes.json
git add deploy/npmplus/routes.json && git commit && git push     # git fica o espelho versionado

# git → DB (aplicar; corre no host, chamado pelo deploy.sh quando routes.json muda num push)
sh deploy/npmplus/npmplus-routes.sh apply     # upsert por domínio + restart npmplus (regen do nginx)
```

- **`npmplus-routes.mjs`** (node:sqlite, corre num container `node:24`): `export` (DB→stdout) / `apply`
  (routes.json→DB, upsert por `domain_names`, **idempotente**, **nunca apaga** hosts extra da UI).
- `apply` faz `docker restart npmplus` **só se algo mudou** (o NPMplus regenera os confs do nginx da DB no
  arranque) — blip de segundos, nunca em no-op.
- ⚠️ **Workflow:** editar na UI é livre; para PERSISTIR/versionar, correr `export` + commit. Editar o
  `routes.json` e dar push → o `deploy.sh` aplica (git ganha para os domínios listados). *(Integração
  dashboard↔NPMplus = trabalho futuro.)*
- 🔒 **GUARDRAIL de sync (one-way):** o fluxo automático é **SÓ `main → hel1-npm`** (o cron faz `git pull` +
  `apply`). O sentido inverso — `hel1-npm → main` (o `export` → commit → push) — é **SEMPRE manual, por um
  humano** (o host só faz `git pull` anónimo, nunca `push`; o `deploy.sh` NÃO exporta nem committa). Isto
  garante que uma edição no servidor (UI/DB) **não se sobrepõe ao nosso código nem chega a `main` por acidente**.
  Mais guardrails a construir; este é o básico e é inegociável.

## Backup / rollback

- **Ficheiros:** `tar czf /root/npmplus-<ts>.tar.gz -C /opt compose.yaml npmplus ...` (Camada A + B DB).
- **CT completo:** `vzdump 103 --mode snapshot --storage pbs-local --notes-template "<nota>"` (hel1-pve).
- **Rollback rápido do compose:** `cp /opt/compose.yaml.bak /opt/compose.yaml && docker compose \
  --project-directory /opt -f /opt/compose.yaml --env-file /opt/.env up -d`.
- **Rollback total:** restaurar o CT 103 do PBS (`pbs-local`, snapshot "antes de migrar NPMplus deploy").
