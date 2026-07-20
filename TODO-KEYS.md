# TODO — API keys a adicionar (gpedro)

Keys **opcionais** e **independentes**. Nada aqui é bloqueante — o pipeline corre sem elas; cada key só
**sobe cobertura/limite** da sua fonte. Onde meter: no `.env` de cada host relevante — pelo **dashboard →
Servidores → Editar .env**, ou no `docker/.env` do hel1. Depois **avisa o Claude** para redeploy (o
`subdomains` já está reativado keyless; as keys entram no próximo recreate).

---

## 1. Subdomains — ⚡ `CERTSPOTTER_API_KEY` é o DESBLOQUEIO (grátis, 2 min) — PRIORIDADE

O consumer `subdomains` corre keyless (subfinder + certspotter-anónimo + crt.sh), mas o keyless teve
**"fetch failed" recorrente sob carga** (o subfinder martela sockets → o caminho undici parte; investigado
a fundo — só recorre sob carga real, não em isolamento). **A `CERTSPOTTER_API_KEY` é o fix definitivo
confirmado:** dá uma fonte HTTP rápida e fiável que **tira o subfinder do caminho crítico** → jobs curtos,
sem hammer de sockets. Mete só esta; as outras 2 são residuais. (Reativei-o keyless entretanto para testar
os fixes deployados — se voltar a orfanar, é à espera desta key.)

| Key | Free tier | O que dá | Como obter |
|---|---|---|---|
| **`CERTSPOTTER_API_KEY`** ⭐ | **10 queries full-domain/hora (~240/dia)** | Fonte primária de CT; tira o certspotter do "429-anónimo" para 240/dia estáveis | 1) conta grátis: https://sslmate.com/signup · 2) key: https://sslmate.com/account/api_credentials |
| `SECURITYTRAILS_API_KEY` | **50 queries/mês** | Complemento (DNS/subdomínios); residual — só corroboração pontual | https://securitytrails.com/app/signup → *Account → API key* |
| `CENSYS_API_ID` + `CENSYS_API_SECRET` | **100 créditos/mês** (cada search gasta créditos) | Complemento (certs); residual | https://accounts.censys.io/register → *Account → API* |

**Recomendação:** só a **`CERTSPOTTER_API_KEY`** vale a pena (2 min, grátis, é a fonte primária). As outras
duas (50–100/mês) são demasiado baixas para valer o esforço — deixa-as, o subfinder já cobre o grosso.
Para o backfill dos 100k a sério seria preciso um tier pago; keyless + certspotter drena em background.

## 2. Wordfence — match de vulnerabilidades WP no wpscan

| Key | Free tier | O que dá | Como obter |
|---|---|---|---|
| **`WORDFENCE_API_KEY`** | grátis (feed v3 completo) | O wpscan keyless passa a **marcar vulns** de plugins/temas/core (sem gastar a quota WPScan 25/dia) | https://www.wordfence.com/products/wordfence-intelligence/ → gera API key |

Depois da key: corre uma vez `update-wordfence.js` (ou espera o timer de 7 dias — **nota:** o
`wordfence-update.timer` ainda **não está instalado** como unit no hel1; é preciso instalá-lo, ou correr o
script à mão). Sem a key, o wpscan keyless continua a enumerar plugins/versões, só **não marca** vulns.

---

## 3. Plataforma de docs — rotas no NPMplus (hel1-npm) ⚠️ A FAZER

A plataforma de docs está **live no np-server** (`100.114.17.74`), mas ainda **não passa pelo NPMplus** —
falta adicionar as *custom locations*/subdomínios no proxy host (na box `hel1-npm`, `/opt/npmplus`, via UI).
Snippets completos em [`docs/runbook-npm-hel1.md`](docs/runbook-npm-hel1.md).

| Superfície | Rota a criar | Backend | Nota |
|---|---|---|---|
| **Docs** | `netprospect.netmaster.pt` → Advanced → `location /docs/ { proxy_pass http://100.114.17.74:8088; }` | docs-web :8088 | **sem barra final** no proxy_pass! |
| **Open Notebook** | subdomínio `notebook.netmaster.pt` | :8502 | Streamlit não faz subpath → subdomínio |
| **Obsidian web** | subdomínio `obsidian.netmaster.pt` | **https** :8091 | `proxy_pass https://...:8091` + **skip cert** (self-signed; KasmVNC exige HTTPS) |
| **(opc.) busca** | `location /api/kb/ { proxy_pass http://100.114.17.74:8099; }` | kb-http :8099 | só se o site usar busca semântica |

Todas herdam **Authentik** do proxy host. `/notebook/` e `/obsidian/` (com dados) **nunca abertos**.

> **Acesso no telefone entretanto:** já funciona por **Tailscale Serve** (HTTPS na tailnet, cert real):
> Docs `https://np-server.taild948a2.ts.net/docs/` · Grafo `…/docs/#/graph` · Notebook `…ts.net:8502/` ·
> Obsidian `…ts.net:8091/`. São estes os URLs que o **grupo "Conhecimento" do dashboard** usa por agora.

> ⚠️ **DEPOIS do NPMplus:** dar ao Claude os 4 URLs finais (`netprospect.netmaster.pt/docs/` + `notebook.`/
> `obsidian.netmaster.pt`) para **trocar os links do grupo "Conhecimento"** no `dashboard/public/index.html`
> (hoje apontam para os URLs Tailscale acima).

## 4. Capacidade de verify — mais workers / 2.º IP Reacher ⚠️ CAPACIDADE (não é uma key)

O verify está **destravado** (Reacher live) mas o backlog é grande (~162k contactos, ~76k domínios elegíveis) e a
vazão é limitada por (a) a quota free das APIs **por-IP** e (b) a capacidade SMTP de **um** Reacher. Duas alavancas
para escalar — **nenhuma precisa de código novo** (a lista de proxies do `lib/reacher.js` já faz round-robin), só ops:

**a) Mais workers de verify** (mais IPs → mais quota free + mais paralelismo):
- Novo VM: `deploy/bootstrap-vm.sh <authkey> <hostname> tag:worker` (instala Docker + Tailscale + clona o repo).
- Pôr `WORKER_ROLES=verify` no `.env` do host pelo **dashboard → Servidores → Editar .env** (fleet-env store); o
  `pull-deploy.sh` recria no próximo ciclo (~5 min). Chaves free em `config/verify-providers.json` mintadas **do IP
  desse host**, ou correr só-Reacher (sem chaves).

**b) 2.º IP no Reacher** (mais IPs limpos por onde o SMTP `RCPT` sai) — **já automatizado** em
`deploy/reacher/add-proxy.sh` (gate FCrDNS + Dante tailnet-bound + append a `config/verify-proxies.json`; o
`lib/reacher.js` já faz round-robin da lista). Faz FCrDNS `p2.<domínio>` → novo IP, sobe um Dante ligado à
tailnet nesse host (o co-locado do de-minio escuta só em `127.0.0.1`) e acrescenta a entrada ao pool.

> ⚠️ **A FAZER (tu):** depois de configurares um **2.º domínio com FCrDNS (`p2.<domínio>`: registo A no
> OpenProvider + PTR no Hetzner Robot) a apontar para um IP HEL1 que NÃO seja o do WHM/cPanel** (o WHM tem a
> porta 25 / a reputação dele — nunca misturar envio-frio com o IP do WHM), corre **no hel1**:
> ```
> ./deploy/reacher/add-proxy.sh <domínio> <IP-HEL1-limpo> <tailnet-IP-desse-host> root@<tailnet-IP>
> ```
> Pré-req: porta 25 aberta + IP Spamhaus-limpo nesse IP HEL1 (`docs/outreach-ops/00-port25-and-ips.md`).
> ⚠️ o script **ainda não foi testado com um IP real** (é a 1.ª execução) — corre e avisa o Claude se algo falhar.
> Ver `deploy/reacher/README.md §Fase 3`.

## 5. Book Call público — excluir `/book/*` do Authentik (NPMplus) ⚠️ A FAZER

A página pública de **marcação de chamada** (`GET /book/:token` + `POST /api/book/:token`) já está no
dashboard (`netprospect.netmaster.pt`) — token-gated (só quem recebeu outreach), mostra os horários livres do
Google Calendar e cria o evento com link Meet. Como o `/r/*` e o `/t/*`, **TEM de ser excluída do Authentik**
no NPMplus — senão o prospecto bate no login do Authentik em vez da página de marcação.

- Na box **`hel1-npm`** (NPMplus), no proxy host de `netprospect.netmaster.pt`: adicionar `/book/` **e**
  `/api/book/` à lista de *locations* públicas (sem auth), tal como já existe para `/r/`, `/t/`.
  (Snippets no estilo de [`docs/runbook-npm-hel1.md`](docs/runbook-npm-hel1.md).)
- Só funciona depois de o **dashboard redeployar** o código novo (pull-deploy do np-server) — confirma com
  `curl -s https://netprospect.netmaster.pt/book/<token>` a devolver a página (não o login).
- Depois: o link entra nos emails de outreach como `https://netprospect.netmaster.pt/book/{{token}}` (CTA
  "marcar chamada"), a substituir o `mailto:` atual do relatório.

---

## Loja pública (Stripe) — passos de deploy (não são API keys, mas são teus)

A loja `/loja` (self-checkout Stripe, modo TEST) está construída. Para funcionar atrás do reverse proxy:

### a) NPMplus / Authentik — excluir as rotas PÚBLICAS da auth
Como já fazes ao `/book/*`, `/r/*`, `/t/*` — a loja é para prospetos SEM login e o webhook é servidor-a-servidor:
- `/loja` e `/loja/sucesso` — página pública da loja
- `/api/store/*` — checkout
- `/api/stripe/webhook` — webhook do Stripe (tem assinatura própria; **não pode** passar pelo Authentik)

No NPMplus, no Proxy Host do dashboard, junta estas locations à lista de paths não-autenticados (onde já estão `/book`, `/r`, `/t`). *(A outra sessão está a construir mais rotas de pagamento — `/buy/:token` etc. — que também precisarão de exclusão quando terminarem.)*

### b) Stripe Dashboard — criar o webhook do netprospect (o secret do netmaster-app NÃO serve)
O signing secret é **por-endpoint**. O que está no store (copiado do netmaster-app) é do endpoint DELE → não verifica os eventos do netprospect. Passos (modo TEST):
1. Stripe → Developers → Webhooks → **Add endpoint**.
2. URL: `https://<dominio-publico>/api/stripe/webhook` · evento: `checkout.session.completed` (+ `invoice.paid` se quiseres recorrência).
3. Copia o **Signing secret** (`whsec_…`) → dashboard → Servidores → Editar .env do **np-server** → `STRIPE_TEST_WEBHOOK_SECRET=` (substitui o valor atual) → avisa o Claude p/ redeploy.
4. (opcional) `STORE_NOTIFY_EMAIL=` (notificação de venda) + `STORE_PUBLIC_URL=https://<dominio>`.
5. Para ir a LIVE: repetir em modo LIVE + `STRIPE_MODE=live` (só depois de validar em TEST).

### c) Moloni — empresa Demo/sandbox para a FATURA da loja (EM ABERTO)
Pediste a fatura da loja numa empresa Demo em sandbox, MAS o `companies/getAll` com as creds LIVE só vê a
**Netmaster Unipessoal Lda (207752)**. Esclarece: o **company_id da Demo**, OU preencher `SANDBOX_MOLONI_*`
(o netmaster-app tem esse bloco), OU **criar** a empresa Demo. Até lá, `STORE_MOLONI_INVOICE` fica off.

### ✅ Já tratado (2026-07-20): SMTP + WhoisXML copiados do netmaster-app
SMTP (`SMTP_HOST/PORT/USER/PASS/SECURE`) → store do **np-server** (o netprospect não tinha email de envio).
`WHOISXML_API_KEYS` (estava em falta → o whois de .pt falhava) → store de np-server + hel1-docker + np-wk-de1 +
oracle-e2-1/2. Ambos vêm da config de produção do netmaster-app.

---

## Onde é usado (referência)
- Subdomains: [`docs/subdomain-sources-keys.md`](docs/subdomain-sources-keys.md) · `lib/subdomains.js`
- Wordfence: `lib/wordfence.js` · `update-wordfence.js` · `deploy/observability/wordfence-update.{service,timer}`
- Plataforma de docs: [`docs/runbook-npm-hel1.md`](docs/runbook-npm-hel1.md) · `deploy/docs/` · `.claude/plans/current/docs-plan.md`
- 2.º IP Reacher: `deploy/reacher/add-proxy.sh` · [`deploy/reacher/README.md`](deploy/reacher/README.md) (§Fase 3)
- Book Call: `dashboard/server.mjs` (`/book/:token`, `/api/book/:token`) · fundação Agendamentos (GCal+Notion)
