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
| **B — routing** | proxy hosts (`X.netmaster.pt → backend`), custom nginx (ex.: `location /docs/`), certs, access-lists | DB SQLite `/opt/npmplus/npmplus/database.sqlite` + `/opt/npmplus/custom_nginx/` | **UI/API** do NPMplus |

**Variáveis de ambiente só resolvem a Camada A.** A Camada B vive na base de dados do NPMplus — não é
declarável por env; reproduz-se por backup do CT (vzdump) ou pela API REST. Nunca editar os ficheiros
gerados do nginx à mão (o NPMplus sobrepõe-nos) — usar sempre a UI/API.

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

## Backup / rollback

- **Ficheiros:** `tar czf /root/npmplus-<ts>.tar.gz -C /opt compose.yaml npmplus ...` (Camada A + B DB).
- **CT completo:** `vzdump 103 --mode snapshot --storage pbs-local --notes-template "<nota>"` (hel1-pve).
- **Rollback rápido do compose:** `cp /opt/compose.yaml.bak /opt/compose.yaml && docker compose \
  --project-directory /opt -f /opt/compose.yaml --env-file /opt/.env up -d`.
- **Rollback total:** restaurar o CT 103 do PBS (`pbs-local`, snapshot "antes de migrar NPMplus deploy").
