# Runbook — API keys das fontes de subdomínios

O `handleSubdomains` usa `lib/subdomains.js`, que combina várias fontes de Certificate Transparency
+ DNS intelligence com merge/dedup e fallback. **Sem keys**, só correm `certspotter` (anónimo) e `crt.sh`
— ambos com free-tier baixo, que **não aguenta o backfill de ~100k** (o certspotter dá `429` em escala e o
crt.sh está cronicamente em baixo). Por isso o consumer `subdomains` está **pausado** até haver ≥1 key.

Cada key é **opcional** e **independente** (ativa a sua fonte). Quantas mais, mais cobertura e menos 429.

---

## Como ativar (depois de obteres as keys)

1. Mete as keys no `.env` de cada host **base** (o dashboard → Servidores → *Editar .env*, ou `docker/.env`
   no hel1). As variáveis:
   ```
   CERTSPOTTER_API_KEY=...        # sobe MUITO o limite do certspotter (a fonte primária) — recomendado
   SECURITYTRAILS_API_KEY=...     # ativa a fonte SecurityTrails
   CENSYS_API_ID=...              # ativa a fonte Censys (par ID+Secret)
   CENSYS_API_SECRET=...
   ```
2. Avisa-me e eu **removo o `paused`** do consumer `subdomains` (`lib/jobs.js`) + redeploy → retoma o backfill
   de 100k, agora com capacidade real.

---

## 1. Certspotter (SSLMate) — **a mais importante** (é a fonte primária)

- **O que é:** monitor de Certificate Transparency da SSLMate. A key sobe o rate-limit da API de emissões.
- **Free tier:** conta grátis dá uma API key com limite muito superior ao anónimo (que satura em 429).
- **Passos:**
  1. Cria conta: **https://sslmate.com/signup** (grátis).
  2. Gera a API key: **https://sslmate.com/account/api_credentials**
  3. `CERTSPOTTER_API_KEY=<a-tua-key>`
- **Docs:** https://sslmate.com/help/reference/ct_search_api_v1

## 2. SecurityTrails

- **O que é:** DNS/subdomain intelligence. Devolve subdomínios conhecidos por domínio.
- **Free tier:** ~50 queries/mês (baixo — bom como fonte complementar, não para 100k sozinho).
- **Passos:**
  1. Cria conta: **https://securitytrails.com/app/signup**
  2. API key: **https://securitytrails.com/app/account/credentials**
  3. `SECURITYTRAILS_API_KEY=<a-tua-key>`
- **Docs:** https://docs.securitytrails.com/  (endpoint `/v1/domain/{domain}/subdomains`)

## 3. Censys

- **O que é:** dados de scan/certs da Internet. Procuramos certificados que cobrem o domínio.
- **Free tier:** limitado (algumas centenas de queries/mês).
- **Passos:**
  1. Cria conta: **https://accounts.censys.io/register**
  2. API ID + Secret: **https://search.censys.io/account/api**
  3. `CENSYS_API_ID=<id>` e `CENSYS_API_SECRET=<secret>`
- **Docs:** https://search.censys.io/api  (endpoint v2 `/certificates/search`)

## 4. subfinder (opcional, o mais poderoso) — CLI

- **O que é:** ferramenta da ProjectDiscovery que **agrega dezenas de fontes passivas** (incl. as de cima +
  hackertarget, virustotal, etc.). Se estiver instalado no worker, `lib/subdomains.js` usa-o automaticamente.
- **Requer:** o binário `subfinder` na imagem do worker (falta adicionar ao Dockerfile) + opcionalmente as
  mesmas keys no config dele (`~/.config/subfinder/provider-config.yaml`).
- **Nota:** ainda **não** está na imagem — é um passo à parte (Dockerfile + rebuild). Digo quando estiver.

---

## Recomendação

Para destravar os 100k, a **CERTSPOTTER_API_KEY** (grátis, fonte primária) é o maior ganho por si só. As
outras (SecurityTrails/Censys) são complementos de cobertura, mas os free-tiers delas são baixos — úteis
sobretudo para lookups on-demand, não para o backfill inteiro. O caminho robusto para escala real é o
**subfinder** (agrega tudo) ou um tier pago de uma destas.
