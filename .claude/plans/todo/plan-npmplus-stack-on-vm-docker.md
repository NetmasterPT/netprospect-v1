# Plano — migrar a stack NPMplus de LXC → VM/Docker + upgrade tratado

> Plano **isolado** (não se sobrepõe ao `v2-platform-plan.md`). Objetivo: tirar o NPMplus do LXC (o README oficial
> desrecomenda) para uma **VM com Docker**, **na mesma altura** que se faz o **upgrade tratado** (pelo fix de
> segurança), mantendo `npm.netmaster.pt` + o forwarding do IP público, com downtime mínimo. Contexto técnico:
> [docs/auth-npmplus-authentik.md](../../../docs/auth-npmplus-authentik.md) · [deploy/npmplus/README.md](../../../deploy/npmplus/README.md).

## Porquê

1. **LXC desrecomendado** (README ZoeyVid): *"I disrecommend you to run the NPMplus container inside an LXC container…
   install docker/podman on the host or in a KVM"*. O nosso é Docker-dentro-de-CT (Alpine, hel1-pve VMID 103).
2. **Falta um fix de SEGURANÇA:** estamos na **2.14.0 (2026-02-19-r3)**; o **2026-04-10-r2** corrigiu um privesc
   (não-admin→admin, NginxProxyManager#5441). A imagem está **PINADA ao digest** `sha256:40f7cfb4…` porque o
   `:latest` (v2.15.1) **parte o stack** (removeu o env `AUTH_REQUEST_AUTHENTIK_DOMAIN`).
3. Simplificar a frota (uma coisa a menos a manter em modo "especial").

## Estado atual (factos verificados)

- **CT 103** em **hel1-pve** (Alpine, Docker), tailnet `100.89.244.50`, LAN `10.10.10.5` (vmbr1), **IP público
  `65.108.120.25`** (forwarding no hel1-pve → CT). Único reverse-proxy de `*.netmaster.pt` (blast-radius = frota toda).
- **Stack** (`/opt/compose.yaml`, gitops `deploy/npmplus/`): npmplus + **Authentik** (postgres/redis/server/worker) +
  **openappsec** (WAF) + **crowdsec** + **tailscale**. Imagem npmplus PINADA `@sha256:40f7cfb4…`.
- **Segredos** em `/opt/.env` (fora do git): OIDC id/secret, CROWDSEC_LAPI_KEY, TS_AUTHKEY, AUTHENTIK pg-pass +
  secret-key, OPENAPPSEC db-pass, + `NPMPLUS_API_EMAIL`/`NPMPLUS_API_PASSWORD`.
- **Camada A** (motor) = `compose.yaml` (git). **Camada B** (routing) = SQLite `/opt/npmplus/npmplus/database.sqlite`,
  **versionada** em `deploy/npmplus/routes.json` (35 proxy hosts, INCLUI o `/api` lockdown do proxy_host #35).
- **Deploy** = `deploy.sh` por cron `*/5` (pull+apply; guardrail: só main→hel1-npm auto). Obs: node-exporter (apk)
  + cadvisor + agente de métricas + Prometheus targets `100.89.244.50:{9100,8098}`.
- **Estado a preservar na migração:** DB do Authentik (users/providers/apps/outposts/flows), certs Let's Encrypt,
  estado do CrowdSec/openappsec, a DB de routing do NPMplus (ou reaplicar via `routes.json`).

## Breaking changes do upgrade (2.14.0 → alvo ≥ 2.15.1)

- **`AUTH_REQUEST_AUTHENTIK_DOMAIN` já não é suportado** → remover do compose (ver o que o substitui no CHANGELOG;
  o forward-auth do Authentik pode ter mudado de config).
- **Ler o CHANGELOG** entre `2026-02-19-r3` e o alvo (release estável mais recente): outros env renomeados,
  formato de config, **migrações de DB** (correm no arranque — irreversíveis; daí o backup + testar noutra máquina).
- Confirmar arch: imagem exige **x86-64-v2** (as VMs Proxmox usam `--cpu host` → ok).

## Decisões a confirmar (utilizador)

| # | Decisão | Recomendação |
|---|---|---|
| D1 | OS da VM | **Debian** (systemd → o `obs-vm-install.sh` da frota funciona nativo; sem os gotchas Alpine/OpenRC) |
| D2 | Nó Proxmox | **hel1-pve** (mesmo nó → forwarding do IP público mais simples de mover) |
| D3 | IP tailnet | **transferir a identidade Tailscale** p/ manter `100.89.244.50` (menos refs a mexer) OU IP novo + atualizar refs |
| D4 | Versão alvo | release **estável mais recente** que arranque com o nosso config corrigido; **pin ao digot** após testar |
| D5 | Migração vs upgrade-in-place | ver "Opção rápida" abaixo |

## Opção rápida (interina) — upgrade IN-PLACE no CT, sem migrar já

Se o fix de segurança for urgente e a migração demorar: fazer o upgrade **no próprio CT** primeiro (fica em LXC,
mas seguro): (1) `vzdump 103 --mode snapshot`; (2) editar `deploy/npmplus/compose.yaml` — remover
`AUTH_REQUEST_AUTHENTIK_DOMAIN` + tratar outros breaking changes + mudar o pin p/ o digest da versão nova; (3)
`docker compose pull npmplus && up -d`; (4) validar (API 200, sites 302/200, login OIDC, forward-auth); (5)
rollback = repor o digest antigo + `up -d`, ou restaurar o CT do PBS. **Recomendado fazer isto cedo** (segurança),
e a migração LXC→VM depois com calma.

## Migração LXC→VM (faseada, downtime mínimo)

### Fase A — provisionar a VM nova (sem tocar no CT antigo)
- Criar VM Debian em hel1-pve (`--cpu host`, qemu-guest-agent, LAN vmbr1 + Tailscale). Ver
  [[netprospect-vm-provisioning]] (NUNCA bootstrap no host Proxmox; cold-boot; --cpu host).
- Instalar Docker + clonar o repo em `/opt/netprospect-v1` + `deploy/observability/obs-vm-install.sh <label>`.

### Fase B — deploy da stack na VM, JÁ na versão nova
- `compose.yaml` com os **breaking changes corrigidos** (sem `AUTH_REQUEST_AUTHENTIK_DOMAIN`, pin ao digest novo).
- `/opt/.env` com os segredos (copiar do CT). `deploy.sh` + cron.
- Subir a stack **isolada** (ainda sem tráfego — testar com `/etc/hosts` local ou um domínio de staging).

### Fase C — migrar o ESTADO
- **Authentik** (crítico): `pg_dump` do `authentik-postgres` do CT → restore na VM (OU copiar o volume com a stack
  parada dos dois lados). Confirmar users/providers/apps/outposts a funcionar.
- **Routing (Camada B):** aplicar `routes.json` na DB nova (`npmplus-routes.sh apply` → recria os 35 hosts + o `/api`
  lockdown) — a via versionada e limpa. (Alternativa: copiar a SQLite.)
- **Certs:** deixar o Let's Encrypt re-emitir na VM (precisa do `.well-known/acme-challenge` a resolver p/ a VM →
  fazer DEPOIS do cutover do IP), OU copiar `/opt/npmplus` (certs) p/ evitar re-emissão no cutover.
- CrowdSec/openappsec: estado recriável (re-registam) — validar.

### Fase D — cutover
- Mover o **forwarding do IP público** `65.108.120.25` (DNAT no hel1-pve/vmbr1) do CT 103 → VM nova. *(Investigar o
  setup exato do forwarding — `iptables`/`nft` no hel1-pve; ainda não mapeado.)*
- **Tailscale:** transferir a auth/identidade p/ manter `100.89.244.50` (D3) OU aceitar IP novo e **atualizar refs**:
  `prometheus.yml` (node/cadvisor targets), `/etc/netprospect-metrics.env`, o allow-list do `/api` lockdown é CIDR
  (100.64.0.0/10) → **não** precisa de mudar.
- DNS: `npm.netmaster.pt` e o resto ficam iguais (apontam ao IP público, que agora encaminha p/ a VM).

### Fase E — verificar + desmantelar
- Verificar TODA a frota: cada `*.netmaster.pt` (302/200), login OIDC ponta-a-ponta, forward-auth (wazuh etc.), o
  `/api` interno (200) + externo (403), a API CRUD, o cron de deploy, a observabilidade (Prometheus scrape).
- Manter o **CT 103 parado** (não apagar) + o vzdump por N dias (rollback = re-mover o forwarding + arrancar o CT).
- Atualizar: `deploy/npmplus/README.md`, `docs/auth-npmplus-authentik.md`, os runbooks, o `fleet` (se o IP mudou),
  a memória [[npmplus-gitops-deploy]] e [[servers-page-telemetry]].

## Riscos

- **Blast-radius total:** este proxy serve `*.netmaster.pt` — o cutover derruba tudo por segundos/minutos. Fazer em
  janela combinada; ter o rollback (re-mover forwarding p/ o CT) a postos.
- **Dados do Authentik** = auth da frota toda; a migração da DB é o passo mais crítico (testar bem antes do cutover).
- **Forwarding do IP público** — ainda não mapeámos o mecanismo exato no hel1-pve; investigar na Fase D.
- **Migrações de DB do NPMplus** no upgrade são irreversíveis → só sobre backup + testado na VM primeiro.

## Passos imediatos (quando retomarmos)
1. Confirmar D1–D5 com o utilizador.
2. Mapear o forwarding do IP público (`65.108.120.25`→CT) no hel1-pve.
3. Ler o CHANGELOG do NPMplus (breaking changes 2.14→alvo) e preparar o `compose.yaml` corrigido.
4. (Se urgente) fazer a **Opção rápida** (upgrade in-place) pelo fix de segurança.
5. Executar A→E.
