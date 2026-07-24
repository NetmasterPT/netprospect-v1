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
| **Ler** (list/get) | ✅ funciona (com `user_permission`) | ✅ |
| **Criar/Editar/Apagar** | ❌ **`Permission Denied`** (ver abaixo) | ✅ (feito: `deploy/npmplus/npmplus-routes.*`) |

⚠️ **Open item — create/write por API:** com um user local (`visibility=all`, tudo `manage`), a **leitura**
funciona mas o **create** é sempre negado (`[Access] ✖ proxy_hosts:create … Permission Denied`, mais um
`TypeError reading 'debug'` secundário no logging). Testado com `roles=["admin"]` E `roles=[]` — ambos falham,
apesar de o schema `proxy_hosts-create.json` (anyOf admin/manage) aparentar ser satisfeito. A UI (gpedro, via
**sessão OIDC**) cria sem problema → a hipótese é que **tokens de password têm scope/tipo insuficiente para
escrita** (vs sessão OIDC), ou o AJV do contexto de create resolve de forma diferente. **A investigar** se
precisarmos mesmo do write-por-API; entretanto o **write é por SQLite** (provado, idempotente).

## ⚠️ Segurança (a fechar)

- **`npm.netmaster.pt` resolve para IP PÚBLICO** (Hetzner, não a tailnet) e o **`/api` está exposto à internet**
  (`/api/schema`→200 público; o OIDC só protege a UI). Ou seja: qualquer um pode sondar/brute-forçar o `/api`,
  protegido só pelo token local. **A fazer:** restringir o `/api` (e o admin) ao **tailnet + localhost** (allow/
  deny no nginx do admin ou DNS só-tailnet), mantendo o nosso acesso interno por `127.0.0.1`+Host+token.
- **Meta:** `/api` (NPMplus e Authentik) só a **tokens válidos com permissão de admin**; nós acedemos de dentro da
  VPN com segredos nossos (`/opt/.env`: `NPMPLUS_API_EMAIL`/`NPMPLUS_API_PASSWORD`), env-configuráveis.

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

## ⚠️ Write por API — conclusão (open item)

Testado exaustivamente: com user local (`roles=["admin"]`/`[]`, `manage`, `visibility=all`) e token de password
(default `["user"]` ou `?scope=admin`), o **create/update/delete dá sempre `Permission Denied`**. Pela leitura do
`access.js` (o `data` validado tem `scope=["user"]`, `roles=["admin","user"]`, `permission=manage`) o schema
`proxy_hosts-create.json` (branch admin) **devia** validar — e não valida. Junto com o `TypeError: reading 'debug'`
que o próprio error-handler lança, a leitura mais provável é um **bug do NPMplus v2.14.0 no create-via-API** (só a
sessão OIDC da UI escreve). **Decisão: o write é por SQLite** (`npmplus-routes`, CRUD completo provado); a **API só
para read**. Reabrir se: (a) upgrade do NPMplus corrigir, ou (b) implementarmos o fluxo OIDC programático.

## Como criar o nosso user de API (por código)

> Preferir o comando **oficial** para a password: `docker exec -it npmplus password-reset.js <EMAIL> <PASSWORD>`
> (em vez de inserir o bcrypt à mão). O user + `user_permission` continuam a criar-se por SQL (a UI/API não os cria
> sem sessão). Password no `/opt/.env`.



`user`+`auth`(bcrypt via `htpasswd -bnBC 10`)+`user_permission`(all/manage) na DB; password no `/opt/.env`. Ver o
script de bootstrap (a versionar em `deploy/npmplus/`). Verificar: `POST /api/tokens` (cookie) → `GET /api/nginx/
proxy-hosts` (com `Host: npm.netmaster.pt`) devolve os hosts.
