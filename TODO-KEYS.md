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

**b) 2.º IP no Reacher** (mais IPs limpos por onde o SMTP `RCPT` sai):
- FCrDNS: `p2.<domínio>` → novo IP (PTR no Hetzner Robot + registo A no OpenProvider) — ver `docs/outreach-ops/dns-per-domain.md`.
- 2.º Dante nesse host, **ligado à tailnet** (o atual só escuta em `127.0.0.1`) — ver `deploy/reacher/`.
- 1 entrada `{host,port,ip,helo}` em `config/verify-proxies.json` a apontar o (único) Reacher para esse Dante.
- Automação pendente: `deploy/reacher/activate.sh` só faz **1 IP** → estender com um modo `add-proxy` (Fase 3 do roadmap).

---

## Onde é usado (referência)
- Subdomains: [`docs/subdomain-sources-keys.md`](docs/subdomain-sources-keys.md) · `lib/subdomains.js`
- Wordfence: `lib/wordfence.js` · `update-wordfence.js` · `deploy/observability/wordfence-update.{service,timer}`
- Plataforma de docs: [`docs/runbook-npm-hel1.md`](docs/runbook-npm-hel1.md) · `deploy/docs/` · `.claude/plans/current/docs-plan.md`
