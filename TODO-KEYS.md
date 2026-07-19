# TODO — API keys a adicionar (gpedro)

Keys **opcionais** e **independentes**. Nada aqui é bloqueante — o pipeline corre sem elas; cada key só
**sobe cobertura/limite** da sua fonte. Onde meter: no `.env` de cada host relevante — pelo **dashboard →
Servidores → Editar .env**, ou no `docker/.env` do hel1. Depois **avisa o Claude** para redeploy (o
`subdomains` já está reativado keyless; as keys entram no próximo recreate).

---

## 1. Subdomains — melhorar a descoberta (hoje a correr keyless via subfinder)

O consumer `subdomains` **já está ativo** em modo keyless (subfinder na imagem + certspotter-anónimo + crt.sh).
Estas keys **não são precisas**, mas sobem o limite/cobertura:

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
| **Obsidian web** | subdomínio `obsidian.netmaster.pt` | :8091 | — |
| **(opc.) busca** | `location /api/kb/ { proxy_pass http://100.114.17.74:8099; }` | kb-http :8099 | só se o site usar busca semântica |

Todas herdam **Authentik** do proxy host. `/notebook/` e `/obsidian/` (com dados) **nunca abertos**.

> **Acesso no telefone entretanto:** o IP-cru por HTTP falha no telemóvel (modo HTTPS-only promove a https
> sem TLS). Ou aplicar o NPMplus acima (dá HTTPS real), ou o Tailscale Serve (HTTPS na tailnet — ver §4 se ativado).

---

## Onde é usado (referência)
- Subdomains: [`docs/subdomain-sources-keys.md`](docs/subdomain-sources-keys.md) · `lib/subdomains.js`
- Wordfence: `lib/wordfence.js` · `update-wordfence.js` · `deploy/observability/wordfence-update.{service,timer}`
- Plataforma de docs: [`docs/runbook-npm-hel1.md`](docs/runbook-npm-hel1.md) · `deploy/docs/` · `.claude/plans/current/docs-plan.md`
