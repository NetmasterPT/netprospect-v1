# Plano — migrar a stack NPMplus de LXC → VM/Docker + upgrade tratado

> ✅ **EXECUTADO (2026-07-24).** Cutover feito (opção A: VMID 103 exato). VM Debian/Docker (VMID 103, hostname
> `npm.netmaster.pt`, LAN `10.10.10.5`, IP público preservado), imagem `2026-07-24-r1`, WAF openappsec ON, 35 hosts,
> `/api` externo 403, gitops (cron `*/5`) + obs (node-exporter+cadvisor, IP tailnet novo `100.119.63.18`). CT LXC
> destruído (vzdump em pbs-local = rollback). **Follow-ups por fazer:** (1) fechar a `:81` do admin exposta no DNAT
> (`NPM_LISTEN_LOCALHOST=true` ou remover a regra); (2) agente de métricas da página Servidores + Alloy (logs) na VM;
> (3) atualizar runbook-npm-hel1.md + docs/auth ("Alpine CT"→VM); (4) investigar backends em baixo no hel1-docker
> (directus/app/api/storybook — pré-existente, não é do proxy). Detalhe em [[npmplus-gitops-deploy]].

> Tirar o NPMplus do LXC (CT 103, o README oficial desrecomenda LXC) para uma **VM Debian com Docker**, na mesma
> altura que se faz o **upgrade tratado** para a última versão oficial, **mantendo o mesmo VMID (103), hostname
> (`npm.netmaster.pt`) e IPs** (LAN `10.10.10.5` + tailnet `100.89.244.50` + forwarding do IP público
> `65.108.120.25`), com downtime mínimo. Contexto: [docs/auth-npmplus-authentik.md](../../../docs/auth-npmplus-authentik.md) ·
> [deploy/npmplus/README.md](../../../deploy/npmplus/README.md).

## Estado verificado (2026-07-24)

**CT 103 (hel1-pve):** Alpine+Docker, 2c/4G/20G, hostname `npm.netmaster.pt`, LAN `10.10.10.5` (vmbr1),
tailnet `100.89.244.50`. Único reverse-proxy de `*.netmaster.pt` → **blast-radius = frota toda**.

**Forwarding do IP público** (DNAT no hel1-pve, `65.108.120.25`): portas **80/443/81 → `10.10.10.5`**. ⇒ se a VM
ficar com `10.10.10.5`, o forwarding **segue sem tocar nas regras**. ⚠️ **Nota de segurança:** a `:81` (admin) está
DNAT'd direto ao público — bypassa o lockdown do `/api` (que é no 443). Tratar (remover a DNAT da :81 OU restringir).

**Estado (tudo bind-mount sob `/opt`, total 485M):** `npmplus/`=40M (DB routing + certs) · `authentik/`=44M ·
`openappsec/`=**324M** · `crowdsec/`=63M · `tailscale/`=135K (**identidade do nó**) · `.env` (segredos).
⇒ **copiar `/opt` inteiro = migrar tudo** (sem pg_dump por-serviço). Copiar com a stack parada = consistente.

**Stack (12 containers):** npmplus (host-net) + Authentik (postgres16/redis7/server/worker, img `2024.12`) +
openappsec (agent+smartsync+shared-storage+tuning+db pg17) + crowdsec (host-net) + tailscale (host-net,
`TS_HOSTNAME=npm-hel1`, state `/opt/tailscale`).

**Template p/ a VM:** `debian-13-cloud-template` (VMID 9000, cpu host, cloud-init). Host tem 314G RAM / 1.4TB
livres. **VMIDs livres:** 104,105,107,…

## Upgrade — versão-alvo e breaking changes (investigado + ENSAIADO)

- **Alvo: `docker.io/zoeyvid/npmplus:2026-07-24-r1`** (última estável; NPMplus usa **tags de data**, não semver —
  a nota antiga "v2.15.1" era falsa). Contém o **fix privesc 2026-04-10-r2** + 2 fixes de segurança de 07-23/07-24.
- **Breaking change que nos parte:** remover `AUTH_REQUEST_AUTHENTIK_DOMAIN` (descontinuado em 2026-04-10-r1);
  manter `AUTH_REQUEST_AUTHENTIK_UPSTREAM`. O forward-auth authentik passou a **single-application mode** via
  **embedded outpost** (`/outpost.goauthentik.io/`) — **os nossos hosts já usam esse modo** (verificado no ensaio).
- Upgrade **DIRETO** (SQLite, migrações forward-only). Efeitos: hosts regenerados + todos os users deslogados
  (cookie mudou). **Backup de `/opt/npmplus` obrigatório** (rollback através da migração não é garantido).

### ✅ ENSAIO na VM 104 (10.10.10.114) — upgrade VALIDADO
Clonei o template → Debian 13 (4c/6G/32G), Docker; copiei `/opt/.env`+`/opt/npmplus` do CT; subi a stack na
imagem nova (compose com o breaking-change tratado). **Resultados:**
- ✅ **Arranca** (sem o crash do `AUTH_REQUEST_AUTHENTIK_DOMAIN`); **migrações de DB correm limpas**
  (2026-02-19-r3 → 2026-07-24-r1).
- ✅ **Gera os 35 proxy_host confs** e **`nginx -t` passa**; backend admin (`/run/npmplus.sock`) sobe.
- ✅ Os hosts com **forward-auth authentik** geram bem (via `/outpost.goauthentik.io/`, o modo que sobreviveu).
- ⚠️ **GOTCHA crítico p/ o cutover:** com o **openappsec FRESCO** (não copiei `/opt/openappsec`) + o módulo de
  attachment ligado, o `nginx -tq` da config-gen **BLOQUEIA** (parou nos 4/35 confs; socket admin não subia). Com o
  módulo desligado → 35/35 em ~30s. ⇒ o openappsec **não-registado bloqueia a geração**. Mitigação no cutover:
  copiar `/opt/openappsec` (estado quente) **e/ou** subir o openappsec e esperá-lo pronto **antes** do npmplus,
  **e/ou** gerar com o módulo off e depois ligar+reload. (Teste do openappsec-quente: [ver §cutover].)
- (O erro certbot npm-4 no ensaio é artefacto do IP isolado — ACME sem o IP público; ignora-se.)

## Decisões (a confirmar com o utilizador)
- **VMID 103 exato** ⇒ obriga a destruir o CT 103 antes de criar a VM 103. Duas vias (trade-off de downtime):
  - **(A) VMID 103, downtime maior (~15-25 min):** ensaiar em VM temporária → no cutover: parar+backup+**destruir**
    CT 103 → `qm clone 9000 103` → correr o install+restore (ensaiado) → IP+tailscale. Simples, ID correto.
  - **(B) VMID temporário, downtime curto (~3-5 min):** VM já construída/quente → cutover só troca IP+tailscale;
    VMID fica ≠103 (renomeável depois com 2º micro-window). Serviço volta muito mais rápido.
  - Recomendação: perguntar ao utilizador. O que importa funcionalmente (hostname+IPs) é igual nas duas.
- Authentik/openappsec/crowdsec: **manter as versões atuais** na migração (mudar só o host + o NPMplus). Upgrades
  desses ficam para follow-up (o Authentik 2024.12→novo tem as suas próprias migrações).

## Cutover (runbook) — janela combinada, rollback pronto

**Pré (não-disruptivo):** VM construída + upgrade ensaiado (feito). Preparar o compose novo (image 2026-07-24-r1,
sem `AUTH_REQUEST_AUTHENTIK_DOMAIN`) **sem committar** (ver ⚠️ abaixo). Confirmar o teste openappsec-quente.

**Sequenciamento do commit do compose (⚠️ senão o CT faz upgrade sozinho):** o `deploy.sh` do CT tem drift-detection
(`cmp SRC LIVE`) → se committar o compose novo, o cron do CT pull→recria o npmplus **na hora** (upgrade não
coordenado do CT vivo). Logo: **não committar o compose até ao cutover**; no cutover, parar/pausar o cron do CT
primeiro, e committar o compose novo só quando a VM já for o alvo (senão o `deploy.sh` da VM reverte o `/opt/
compose.yaml` para o compose antigo do git → downgrade).

**Janela:**
1. `vzdump 103 --mode snapshot` (backup do CT — rollback).
2. Pausar o cron `deploy.sh` do CT.
3. Parar a stack do CT (`docker compose down`) → estado consistente + liberta `10.10.10.5` e a identidade tailscale.
4. **Sync final** `/opt` do CT (parado) → VM. Backup de `/opt/npmplus` (parte do upgrade).
5. Na VM: subir **openappsec + tailscale + authentik + crowdsec** primeiro; **esperar o openappsec-agent registado**
   (evita o hang); dar à VM o IP `10.10.10.5` + a identidade tailscale (100.89.244.50).
6. Subir o **npmplus** (imagem nova). Confirmar 35 confs + `nginx -t` + socket admin.
7. O DNAT (→`10.10.10.5`) já bate na VM. **Verificar a frota:** cada `*.netmaster.pt` (302/200), login OIDC,
   forward-auth, `/api` interno 200 / externo 403, a API CRUD (gpedro@).
8. (Via A) destruir CT 103 + `qm clone`→103 conforme a decisão do VMID.

**Rollback:** re-apontar o forwarding + arrancar o CT (ou restaurar do PBS) + repor o cron.

## Pós-cutover
- Obs onboarding (agora **systemd nativo** → `obs-vm-install.sh` da frota funciona; adeus gotchas Alpine/OpenRC).
- Committar o compose novo (image pin 2026-07-24-r1) + atualizar deploy.sh se preciso; confirmar o cron gitops na VM.
- Tratar a exposição da **:81** no DNAT. Atualizar README/docs/auth/runbooks + memórias [[npmplus-gitops-deploy]],
  [[servers-page-telemetry]], [[netprospect-fleet-runbooks]]. Manter o CT 103 parado + vzdump N dias.

## Riscos
- **Blast-radius total** (proxy de `*.netmaster.pt`) → janela combinada + rollback pronto.
- **openappsec bloqueia a config-gen** se não estiver registado → ordering + estado quente (ver ensaio).
- **Dados do Authentik** = auth da frota → copiar `/opt/authentik` com a stack parada (consistente).
- **Identidade tailscale** = copiar `/opt/tailscale` com a do CT parada (senão conflito de nó online duplicado).
