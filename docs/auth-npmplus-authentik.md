# Auth da plataforma — NPMplus + Authentik (findings)

> Documenta o modelo de autenticação/autorização do reverse-proxy (NPMplus) e do SSO (Authentik), e
> **como gerir os proxy hosts por API/DB** — resultado de leitura das docs oficiais + engenharia inversa do
> código a correr (imagem `zoeyvid/npmplus:latest`, **v2.14.0**, Express 5.2.1, Node 24) e testes E2E.
> Ver também [runbook-npm-hel1](runbook-npm-hel1.md) e `deploy/npmplus/README.md`.

## Panorama

- **NPMplus** (fork do Nginx Proxy Manager) é o único reverse-proxy da frota (`*.netmaster.pt`), no CT
  **hel1-npm** (`npm.netmaster.pt`, tailnet `100.89.244.50`). A stack (nosso `deploy/npmplus/compose.yaml`,
  imagem **oficial** — o `/usr/local/bin/index.js` é symlink→`/app/index.js`, sem fork): npmplus + Authentik +
  openappsec + crowdsec + tailscale.
- **Authentik** é o IdP (OIDC/OAuth2). O NPMplus tem **OIDC built-in** (`OIDC_ISSUER_URL=…/application/o/npmplus/`)
  que faz o **login da UI** (browser) via Authentik. O `AUTH_REQUEST_AUTHENTIK_*` é para **forward-auth de sites
  proxied** (access-lists), coisa diferente do login do admin.

## Duas camadas de config

| Camada | O quê | Onde |
|---|---|---|
| **A — motor** | TLS/OIDC/portas/segredos/WAF | `compose.yaml` + `/opt/.env` (git + host) |
| **B — routing** | proxy hosts, custom-nginx, certs, access-lists | **DB SQLite** `/opt/npmplus/npmplus/database.sqlite` |

## Como a API do NPMplus autentica (o essencial)

1. **O OIDC só gateia a UI (browser), NÃO a API.** Um erro fácil: bater em `https://127.0.0.1/api` sem o header
   `Host: npm.netmaster.pt` → cai no **default server** do nginx → `302` para `netmaster.pt` (parece OIDC, não é).
   **Sempre com `Host: npm.netmaster.pt`.**
2. **Login:** `POST /api/tokens` `{identity, secret}` (email+password de um **user LOCAL do NPM**, não OAuth do
   Authentik). Devolve o JWT num **cookie** `token=…; Path=/api; HttpOnly; Secure; SameSite=Strict` (o corpo só
   tem `expires`).
3. **Uso:** o `lib/express/jwt-decode.js` lê o token **SÓ do cookie** (`req.cookies?.token`) — **Bearer não
   funciona**. Usar um cookie jar (`curl -c/-b`).
4. **Middleware `Sec-Fetch-Site`** (app.js): rejeita 403 se ≠ `same-origin`/`none`/ausente. `curl` sem esse header
   passa (ausente = ok).
5. **Backend interno porta 81** (https): responde a `/api`, `/api/tokens`, `/api/schema` (bypassa o default
   server), MAS **não** serve `/api/nginx/*` (backend parcial) — usar sempre `Host: npm.netmaster.pt` no 443.

## Autorização (o modelo de permissões — `lib/access.js`)

- Um user precisa de **3 linhas na DB**: `user` (roles), `auth` (type=`password`, secret=**bcrypt** `$2b$`,
  meta=`{}`), **e `user_permission`** (visibility + proxy_hosts/redirection_hosts/dead_hosts/streams/access_lists/
  certificates). **Sem a linha `user_permission`** → `access.js` rebenta a ler `.visibility` de `null` → o pedido
  falha (foi o que me bloqueou a leitura no início).
- `access.js` faz `user.roles.push("user")` no check (o role "user" é implícito).
- Cada operação valida (AJV) o contexto contra `lib/access/<recurso>-<op>.json`. Ex.: `proxy_hosts-list.json` /
  `proxy_hosts-create.json` são `anyOf`: **(a)** `roles#/definitions/admin` (scope⊇"user" **e** roles⊇"admin"),
  **ou (b)** `permission_<recurso>` = `view`/`manage` + roles=`["user"]`. Valores de permissão: `view` (`^(view|
  manage)$`) e `manage` (`^(manage)$`).

## Estado do CRUD por API (testado E2E)

| Op | Via API (token local) | Via SQLite direto |
|---|:-:|:-:|
| **Ler** (list/get) | ✅ | ✅ |
| **Criar / Editar / Apagar** | ✅ **funciona** | ✅ (`deploy/npmplus/npmplus-routes.*`) |

✅ **CRUD completo por API — CONFIRMADO (não há bug no NPMplus).** Testado E2E: `POST` cria (id=42), `PUT` edita,
`DELETE` apaga (de volta a 35 hosts). O que exige: user local com `roles=["admin"]` **e** linha `user_permission`
(`visibility=all`, tudo `manage`) **e** login válido (o token vai em cookie). **⚠️ Lição/gotcha que me enganou
horas:** se o **login falha** (password errada → HTTP 400), o cookie fica vazio e o `access.js` `init()` lança
`PermissionError("Permission Denied")` — que **parece** um erro de permissão de escrita mas é só **token ausente**.
Confirmar sempre `login=200` antes de diagnosticar permissões. Definir a password pelo comando **oficial**:
`docker exec npmplus password-reset.js <EMAIL> <PASSWORD>` (evita mismatches de bcrypt/estado).

## Segurança — `/api` do NPMplus FECHADO ao público ✅

`npm.netmaster.pt` está em **IP público** (Hetzner) e o `/api` estava exposto à internet (o OIDC só protege a UI).
**Fechado** assim: o `npm.netmaster.pt` é o **proxy_host #35** (encaminha tudo → `https://127.0.0.1:81`, o admin);
acrescentei ao `advanced_config` dele um `location /api` com **`allow 127.0.0.1; ::1; 100.64.0.0/10;
fd7a:115c:a1e0::/48; deny all;`** + o mesmo proxy p/ o admin. Verificado: `/api` externo → **403**; `/api` de
localhost/tailnet → funciona; a **UI (`/`) continua pública** (OIDC). Aplicado **pela API** (PUT ao proxy_host 35 —
o NPMplus valida `nginx -t` + reload, sem restart) e **versionado no `routes.json`** (Camada B). Admins acedem pela
**VPN**; a automação por `127.0.0.1`+Host+token (segredo no `/opt/.env`: `NPMPLUS_API_EMAIL`/`NPMPLUS_API_PASSWORD`).

**Authentik — NÃO se restringe o `/api` a nível de rede.** ⚠️ o **login do Authentik executa via `/api/v3/flows/`**
(AJAX do browser durante o login) — bloquear `/api` partiria a autenticação de TODA a frota. A gestão do Authentik
(`/api/v3/core/*` etc.) já é protegida pelo **RBAC próprio** (sessão/token admin); os endpoints OIDC
(`/application/o/`) e forward-auth (`/outpost.goauthentik.io/`) TÊM de ser públicos. Hardening extra = restringir
**paths de gestão específicos** (não o `/api/` inteiro) — follow-up.

## ⚠️ Versão — PINADA à 2.14.0 (o :latest parte o stack)

Update tentado (2026-07-24) `docker compose pull` → trouxe a **v2.15.1** que **removeu o env
`AUTH_REQUEST_AUTHENTIK_DOMAIN`** (+ breaking changes) → nginx não serviu (outage breve, ~2 min). **Rollback** à
imagem boa (`sha256:40f7cfb4…` = 2026-02-19-r3) + **pin ao digest** no `compose.yaml` (evita re-pull do latest
partido). **⚠️ falta o fix de segurança do 2026-04-10-r2 (privesc não-admin→admin)** — o upgrade tem de ser feito
**tratando os breaking changes** do compose + testar (com backup). Backup: `vzdump 103 --mode snapshot` (feito).

## Load balancing (NPMplus, oficial)

A UI **não** faz upstream-LB, mas o NPMplus suporta-o por **custom-nginx**: definir um bloco `upstream cu_<nome>
{ … }` em `/opt/npmplus/custom_nginx/http_top.conf` (o prefixo **`cu_`** é obrigatório p/ o NPMplus detetar), e no
proxy host pôr o **forward hostname = `cu_<nome>`** e o **forward port vazio**. → versionável no nosso repo
(`deploy/npmplus/custom_nginx/`) + deployado como a Camada B. É a via para o LB quando lá chegarmos.

## API do Authentik (para a futura integração dashboard)

- Base: `https://auth.netmaster.pt/api/v3/`; schema OpenAPI em `/api/v3/schema/`; browser embutido em `/api/v3/`.
- **Auth:** **API token** de um **service account** (criar em Directory → Users → Service account → gera token) →
  header `Authorization: Bearer <token>`. Gere providers/apps/outposts (`/providers/*`, `/core/applications/*`,
  `/outposts/*`).
- **M2M:** Authentik faz **client-credentials** no token endpoint `/application/o/token/` (client_id+secret, scopes
  `openid` + `goauthentik.io/api`). NB: isto dá um token da **API do Authentik**, NÃO uma sessão do NPMplus — o
  NPMplus usa o SEU próprio token (cookie), não aceita Bearer OIDC. Logo o write-por-API do NPMplus **não** se
  resolve pelo Authentik; a UI escreve por **sessão OIDC** (fluxo authorization-code → callback → cookie do NPMplus).

## Write por API — RESOLVIDO ✅

Confirmado que a **escrita por API funciona** (create/update/delete). A confusão anterior ("Permission Denied")
era um **falso positivo por login falhado** (password de teste desatualizada → token vazio → `init()` lança
"Permission Denied"). Validado com a replicação AJV standalone (o schema `proxy_hosts-create.json` VALIDA com
`scope=["user"]`+`roles=["admin","user"]`+`manage`) e depois E2E com login OK. → Podemos gerir os hosts pela **API
OU por SQLite** (`npmplus-routes` — ganha o modo `NPMPLUS_ROUTES_METHOD`). A API é preferível (regenera o nginx
corretamente, sem restart); o SQLite fica de fallback.

## Como criar o nosso user de API (por código)

> Preferir o comando **oficial** para a password: `docker exec -it npmplus password-reset.js <EMAIL> <PASSWORD>`
> (em vez de inserir o bcrypt à mão). O user + `user_permission` continuam a criar-se por SQL (a UI/API não os cria
> sem sessão). Password no `/opt/.env`.



`user`+`auth`(bcrypt via `htpasswd -bnBC 10`)+`user_permission`(all/manage) na DB; password no `/opt/.env`. Ver o
script de bootstrap (a versionar em `deploy/npmplus/`). Verificar: `POST /api/tokens` (cookie) → `GET /api/nginx/
proxy-hosts` (com `Host: npm.netmaster.pt`) devolve os hosts.
