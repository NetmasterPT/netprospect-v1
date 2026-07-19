---
title: Mapa de Módulos (código)
type: reference
tags: [code, modules, generated]
related: [[README]]
owner: plataforma
status: living
updated: 2026-07-19
visibility: internal
---

<!-- GERADO por docs-site/scripts/gen-module-api.mjs — NÃO editar à mão. Correr: npm run gen:modules -->

# Mapa de Módulos (código)

Sumário de cada módulo (do comentário de cabeçalho) + exports. **65 ficheiros**.

## lib/ — biblioteca

### `lib/artifacts.js`
lib/artifacts.js Armazém de SNAPSHOTS de páginas (MinIO / S3). Um job `fetch` guarda o bundle da página UMA vez; os jobs de análise (fingerprint/social/locality/industry/…) leem daqui em vez de refazer o fetch. Versionado por site+timestamp → alimenta também a deteção de mudanças (Fase E). Bundle: { finalUrl, status, headers, setCookies, html, pages:[{url,html}], fetchedAt } Chaves: `<siteId>/<ts>.json` (histórico) + `<siteId>/latest.json` (ponteiro).

**Exports:** `ensureBucket()` · `putSnapshot()` · `getSnapshot()` · `ensureReportsBucket()` · `putReport()` · `getReport()` · `listVersions()`

### `lib/bank-transfer.js`
lib/bank-transfer.js — transferência bancária (dados de payout). Trivial: expõe IBAN/BIC/titular do env. Fail-soft: bankTransferEnabled().

**Exports:** `getBankTransferConfig()` · `bankTransferEnabled()` · `paymentInstructions()` · `isBankTransferConfigured`

### `lib/campaign-ai.js`
lib/campaign-ai.js — Fase F: gera a cópia de e-mail PERSONALIZADA por destinatário. Usa os sinais do próprio site (plataforma, velocidade, SEO, segurança, SSL/domínio, GMB…) para que cada e-mail seja materialmente diferente (personalização real + anti-spam). Ollama (Gemma) quando disponível; senão, template de fallback do config/campaign-angles.json — a campanha funciona sempre, com ou sem IA.

**Exports:** `buildVariables()` · `renderTemplate()` · `fallbackEmail()` · `generateEmail()` · `ANGLES` · `angleConfig`

### `lib/coingate.js`
lib/coingate.js — núcleo do cliente CoinGate (cripto). Port do netmaster, toggle via env (COINGATE_MODE=live → LIVE_*, senão SANDBOX_*). Bearer token. Fail-soft.

**Exports:** `getCoinGateConfig()` · `coingateEnabled()` · `coingateCall()` · `isCoinGateConfigured`

### `lib/company.js`
Identidade de empresa: chave de deduplicação (org_domain). Objetivo: quando um mesmo dono tem vários domínios (ex: empresa.pt + empresa.com), colapsar numa só empresa. Sinal usado: o domínio do email de contacto. PROBLEMA: emails de template/placeholder (hello@fruits.co, o.seu@email.com) contaminam este sinal e causam fusões falsas. Por isso a fusão entre domínios diferentes só acontece quando CORROBORADA: o domínio do email é, ele próprio, um site conhecido no nosso conjunto (`knownDomains`). Um domínio de template nunca está no conjunto, logo nunca funde por engano.

**Exports:** `emailBusinessDomain()` · `orgDomain()`

### `lib/contacts.js`
Extração (heurística) de contactos de PESSOAS a partir do HTML de um site. Funções puras (sem rede) — o fetch fica em extract-contacts.js. Estratégia (v1, otimizada para PRECISÃO): descobrir páginas "equipa/quem-somos/contactos", e daí extrair pares (nome, cargo) ancorados em palavras-chave de liderança + emails que são claramente de pessoa ou de cargo (os departamentais/genéricos/placeholder são ignorados). Guarda sempre a proveniência (URL) de cada achado.

**Exports:** `findContactLinks()` · `canonicalRole()` · `roleCategory()` · `htmlToText()` · `extractPeople()`

### `lib/crtsh.js`
Acesso partilhado ao PostgreSQL público do crt.sh (Certificate Transparency). Usado por crtsh-enum.js (CLI) e enrich-subdomains.js (preencher sites.hostnames). NOTA: a base `guest` é uma RÉPLICA que cancela queries abrangentes (TLD inteiro) e tem limites de ligações. Usar por domínio específico e sem paralelismo agressivo.

**Exports:** `runQuery()` · `fetchNames()` · `isTransient`

### `lib/directus.js`
Fábrica do cliente Directus (SDK v23) autenticado com token estático.

**Exports:** `makeClient()` · `ensureStaticToken()` · `DIRECTUS_URL` · `DIRECTUS_TOKEN`

### `lib/documenso.js`
lib/documenso.js — cliente HTTP do Documenso (assinatura de contratos). Port 1:1 do netmaster (self-contained, fetch nativo). Bearer token; sem sandbox/live. Fail-soft: documensoEnabled().

**Exports:** `getDocumensoConfig()` · `documensoEnabled()` · `documensoCall()` · `fetchSignedDocumentPdf()` · `generateDocumentFromTemplate()` · `isDocumensoConfigured`

### `lib/egress.js`
lib/egress.js Diversidade de IP: encaminha o egresso HTTP EXTERNO do worker (sites-alvo, GMB, crt.sh…) por um proxy — tipicamente um exit node Tailscale — SEM afetar as chamadas internas (directus/minio/ollama/nats), que continuam diretas. `EGRESS_PROXY` = URL do proxy HTTP (ex.: http://tailscale-egress:1055 do `tailscaled --outbound-http-proxy-listen`). Vazio = direto. - fetch externo: fetch(url, { dispatcher: egressDispatcher() }) - Chromium: browserProxyArg() -> `--proxy-server=...` - crt.sh (PG raw) NÃO passa por proxy HTTP → usar o modo KERNEL do sidecar Tailscale (network_mode: service) p/ rotear TODO o egresso, incl. PG.

**Exports:** `hasEgressProxy()` · `initEgress()` · `egressDispatcher()` · `browserProxyArg()`

### `lib/email-junk.js`
lib/email-junk.js — filtro central de emails-lixo para a extração de contactos. Junta o que estava disperso em contacts.js/fingerprints.js e acrescenta duas classes que estavam a poluir os dados (descoberto no audit de qualidade): 1) SUPORTE DE PROVIDERS de hosting/site-builder (support@loopia.se aparecia em 417 sites de clientes deles) — não são leads, são o rodapé legal do provider. 2) PLACEHOLDERS/exemplos (etunimi.sukunimi@esimerkki.fi = "firstname.surname@ example.fi", matti.meikalainen, max.mustermann, john.doe, anna.andersson…). 3) Terceiros genéricos (dpo-google@google.com, @facebook.com, @shopify.com…).

**Exports:** `isJunkEmail()` · `PROVIDER_DOMAINS`

### `lib/email-verify.js`
Inferência de emails por padrão + pré-filtro de verificação (sintaxe, MX, role/departamental, disposable, catch-all). Funções puras/rede-baixa; a orquestração + probes (Reacher/APIs) ficam em verify-emails.js + lib/verify-core.js. (O antigo smtpProbe raw foi retirado — o Reacher/self-hosted faz o handshake SMTP.)

**Exports:** `classifyCatchAll()` · `nameTokens()` · `generatePatterns()` · `resolveMx()` · `syntaxValid` · `isRoleLocal` · `isDisposable`

### `lib/env.js`
Carregador mínimo de docker/.env (sem dependências) para os scripts Node. Não sobrepõe variáveis já definidas no ambiente.

**Exports:** `loadEnv()`

### `lib/eupago.js`
lib/eupago.js — núcleo do cliente EuPago (Multibanco/MBWay/Payshop, PT). Port do netmaster, toggle via env (EUPAGO_MODE=live → clientes.eupago.pt, senão sandbox). API legacy v1: `chave` no body; sucesso=false → erro. Fail-soft: eupagoEnabled().

**Exports:** `getEuPagoConfig()` · `eupagoEnabled()` · `eupagoCall()` · `smokeEuPago()` · `isEuPagoConfigured`

### `lib/fingerprints.js`
Deteção por fingerprint (HTML + cabeçalhos + cookies) das plataformas-alvo, deteção de CDN, idioma e extração de contactos gerais. Estas regras determinam a decisão FIÁVEL de `qualified` (o simple-wappalyzer acrescenta deteção mais ampla, mas a qualificação é feita aqui).

**Exports:** `detectPlatforms()` · `detectCDN()` · `extractLang()` · `extractContacts()` · `TARGET_SLUGS`

### `lib/geoip.js`
Resolução de IP -> ASN / ISP / país. Preferência: bases GeoLite2 da MaxMind (.mmdb) lidas offline (ilimitado, sem enviar IPs para terceiros — mais limpo do ponto de vista de RGPD). Basta colocar GeoLite2-ASN.mmdb e GeoLite2-Country.mmdb em data/geoip/ (precisa de uma chave gratuita da MaxMind, uma só vez). Fallback automático (se as .mmdb não existirem): Team Cymru via DNS (origin.asn.cymru.com), sem conta. É um serviço ao vivo — usamos cache por IP.

**Exports:** `makeGeoIP()`

### `lib/google-auth.js`
lib/google-auth.js — JWT de service-account partilhado (domain-wide delegation). Uma conta de serviço serve Calendar/Drive/Docs/… via scopes alargáveis. Impersona o utilizador-alvo (subject). Fail-soft: googleEnabled() (sem creds → null).

**Exports:** `googleEnabled()` · `getJWT()` · `DEFAULT_SCOPES`

### `lib/google-calendar.js`
lib/google-calendar.js — cliente Google Calendar. Port do netmaster (usa o JWT partilhado de google-auth.js). createEvent (âncora + Meet via conferenceDataVersion:1, requestId dedup), appendEventDescription (liga o Notion), deleteCalendarEvent (404/410-tolerante), getBusyIntervals. isCalendarConfigured() = googleEnabled.

**Exports:** `getCalendarClient()` · `getBusyIntervals()` · `createEvent()` · `appendEventDescription()` · `deleteCalendarEvent()` · `isCalendarConfigured`

### `lib/jobs.js`
lib/jobs.js Camada fina sobre NATS JetStream para a pipeline orientada a jobs. UM stream workqueue (`NP_JOBS`, storage=file, dedup 24h) com vários subjects; cada subject tem o SEU consumer durável (filtros disjuntos — requisito do workqueue). Prioridade das auditorias = 3 subjects (JetStream não tem prioridade nativa): o worker drena ondemand → qualified → rest. Idempotência: publicar com `Nats-Msg-Id` (o dedup do stream ignora repetições dentro da janela). Redelivery reescreve o mesmo registo (upsert por domínio).

**Exports:** `consumersForRoles()` · `connectJobs()` · `ensureStream()` · `ensureConsumer()` · `publishJob()` · `STREAM` · `SUBJECT_PREFIX` · `SUBJECTS` · `CONSUMERS` · `decodeJob` · `isTransientJobErr`

### `lib/known-domains.js`
Carregador endurecido do conjunto de "domínios conhecidos" (usado p/ dedup no discover e corroboração de fusões de empresa por email em orgDomain). Vive em lib/ DE PROPÓSITO: lib/ é volume-mounted nos workers (deploy/worker/docker-compose.yml + docker/docker-compose.yml), por isso o fix chega à frota no próximo recreate SEM rebuild da imagem (enrich-sites.js, na raiz, é COPY'd/baked e não atualizaria com COMPOSE_BUILD=0). Corrige o incidente do "base-worker domain-reload storm": (a) PG DIRETO — o read (~1,5M linhas) passa a ser SELECT direto (via PgBouncer) em vez de readItems('sites') pelo Directus de 4c. Vários workers a recarregar em uníssono já não pressionam o control-plane → sem cascata 503 → timeouts → ciclos. (b) GUARD — retry com backoff; NUNCA fica com 0 domínios em SILÊNCIO (o bug antigo do `catch { /* coleção vazia */ }`). Se falhar mesmo, avisa ALTO (degradado visível). (c) JITTER (opcional) — atraso 0-10s p/ dessincronizar arranques simultâneos da frota.

**Exports:** `loadKnownDomains()`

### `lib/lead-score.js`
lib/lead-score.js Índice de lead (0-100) por combinação ponderada de sinais (config/lead-score.json). score = min(max_score, soma dos pesos dos sinais presentes). Devolve também o breakdown {sinal: pontos} para transparência no dashboard. Pesos editáveis sem redeploy; sinais de Fase D (ssl/whois/cms) já previstos com peso 0.

**Exports:** `loadScoreConfig()` · `scoreSite()` · `SCORE_SIGNALS`

### `lib/mailer.js`
lib/mailer.js — envio de e-mails de campanha. Fase F: transporte SMTP único (env SMTP_*), dry-run sem config. Outreach Fase 2: POOL multi-conta (makeMailerPool) — 1 transporte por mailbox das VMs de envio (config/sending-accounts.json), para round-robin + caps + warmup. Tracking: pixel de abertura + wrapping de links (clique) → /t/o/:token e /t/c/:token. Rodapé de opt-out + cabeçalho List-Unsubscribe one-click (exigido pelo Gmail/Yahoo 2024).

**Exports:** `sendEmail()` · `verifyTransport()` · `makeMailerPool()` · `mailerMode` · `mailerEnabled`

### `lib/metrics.js`
lib/metrics.js — Fase E: séries temporais + deteção de mudança (ClickHouse). Fail-soft por design: analytics NUNCA pode partir a pipeline. Se CLICKHOUSE_URL não estiver definido, tudo é no-op. Erros são engolidos (log de debug apenas). Uso principal — `recordRun(site, metrics, {runId})`: 1. lê a última observação de cada métrica deste site (1 query); 2. insere as novas observações; 3. compara nova vs última e insere change_events (só quando há histórico). Opcionalmente também faz capture() para PostHog se POSTHOG_* estiver definido.

**Exports:** `capture()` · `ensureSchema()` · `getTimeline()` · `getTriggers()` · `recordRun()` · `metricsEnabled` · `posthogEnabled`

### `lib/moloni-sync.js`
lib/moloni-sync.js — sync de LEITURA Moloni → Directus (A3), COM THROTTLING. Estratégia (evita o "Under pressure" do Directus): em vez de N lookups por linha, faz 1 leitura batched das chaves relevantes → match EM MEMÓRIA → escreve EM LOTE com pausas. Tipos de documento resolvidos dinamicamente via /documentTypes/getAll (SAFT code → slug). Corre onde a lib/ + @directus/sdk existem (container/host).

**Exports:** `syncCustomers()` · `syncProducts()` · `syncDocuments()` · `syncDocumentsByType()` · `syncAvencas()` · `syncEntity()` · `syncAll()` · `SAFT_SLUG`

### `lib/moloni-write.js`
lib/moloni-write.js — escrita no Moloni (Fase B). Layer genérico (o caller passa o payload). Catálogos por fallback (1º item da conta, cache). SEGURANÇA: os documentos criam-se por DEFEITO como RASCUNHO (status=0), mesmo em modo live — só finaliza (status=1, comunica à AT, irreversível) se `status:1` for pedido explicitamente. Achados dos testes na live: (1) cada linha precisa de product_id real → ensureProduct; (2) a série tem de casar com o tipo → auto-heal do document_set_id.

**Exports:** `createCustomer()` · `updateCustomer()` · `createProduct()` · `ensureProduct()` · `docTypeSupported()` · `createDocument()` · `createNotaCredito()` · `finalizeDocument()` · `deleteDocument()`

### `lib/moloni.js`
lib/moloni.js — cliente HTTP low-level do Moloni (API clássica v1). Port do netmaster-app (api/src/services/invoicing/moloni-client.ts), SEM Feathers/Directus. As 3 manhas do Moloni: 1. o body dos POST é `application/x-www-form-urlencoded` (JSON → "No company_id received") 2. o `access_token` vai na QUERY STRING, não no header Authorization 3. arrays aninhados usam notação PHP-bracket: products[0][taxes][0][tax_id]=… Auth: OAuth2 password-grant contra `${API_BASE}/grant/`. Token em cache no processo, refrescado 5 min antes de expirar. Se o refresh falhar (janela de 14 dias expirou), cai no password-grant — self-healing, sem re-auth manual. Sandbox vs live: env `MOLONI_MODE`. MOLONI_MODE=live → creds MOLONI_*, documentos fechados (status=1) qualquer outro valor → creds SANDBOX_MOLONI_*, rascunhos (status=0) — default seguro Lido uma vez por processo; mudar de modo exige `docker compose up -d --force-recreate`. Fail-soft (estilo do repo, cf. lib/ollama.js): `moloniEnabled()` (sync) diz se há creds; `getConfig()` lança com detalhe se faltar algo; `moloniCall()` lança em erro HTTP ou nos 4 formatos de erro do Moloni.

**Exports:** `moloniEnabled()` · `getConfig()` · `isMoloniConfigured()` · `moloniCall()` · `fetchPdfBuffer()` · `_clearCaches()`

### `lib/notion.js`
lib/notion.js — cliente Notion focado nos Agendamentos (Fase G). Reusa as técnicas do netmaster (descoberta de data source + property-aliases type-aware + blocos com links), SEM a cauda order/lead-cêntrica. notionEnabled() fail-soft.

**Exports:** `notionEnabled()` · `createAgendamentoPage()` · `isNotionConfigured`

### `lib/ollama.js`
lib/ollama.js — cliente Ollama PARTILHADO (/api/generate + JSON estruturado + timeout + keep_alive). De-duplica o padrão que estava em lib/campaign-ai.js e lib/audit/ollama-classify.js; também serve os agentes IA do dashboard. OLLAMA_URL vazio → desligado: ollamaGenerate devolve { ok:false } e os callers caem no fallback. `format` (JSON schema) força saída JSON estruturada. Nunca lança por rede/timeout — devolve { ok:false, error }.

**Exports:** `ollamaGenerate()` · `ollamaWarmup()` · `ollamaEnabled` · `ollamaModel`

### `lib/openprovider-ssl.js`
lib/openprovider-ssl.js — SSL via OpenProvider. Port 1:1 do netmaster (partilha o token de openprovider.js). listSslProducts / orderSslCertificate (dry-run por defeito) / getSslOrderStatus. PRODUCT_ID_MAP fica a 0 até confirmar o catálogo.

**Exports:** `listSslProducts()` · `orderSslCertificate()` · `getSslOrderStatus()`

### `lib/openprovider.js`
lib/openprovider.js — cliente da API OpenProvider (domínios). Port 1:1 do netmaster-app (self-contained, fetch nativo): auth com cache de token (~23h) + check de disponibilidade em lote (máx 15/req). Fail-soft: openproviderEnabled().

**Exports:** `openproviderEnabled()` · `getToken()` · `checkDomains()` · `resetTokenCache()` · `isConfigured`

### `lib/paypal.js`
lib/paypal.js — núcleo do cliente PayPal (Fase F, sem feature). Port do netmaster, toggle sandbox/live via env (PAYPAL_MODE=live → LIVE_*, senão SANDBOX_*). OAuth2 client_credentials com cache de token. paypalCall(path, opts). Fail-soft.

**Exports:** `getPayPalConfig()` · `paypalEnabled()` · `paypalCall()` · `isPayPalConfigured`

### `lib/pgwrite.js`
lib/pgwrite.js Caminho de escrita DIRETA no Postgres (via PgBouncer) para o hot-path dos workers, contornando o Directus REST (auth + hooks + validação + 1 upsert por HTTP call). É a alavanca A2 do plano postgres-scaling. Ligado por DIRECT_PG_WRITE=true (+ PG_WRITE_*). Fail-closed: se desligado/sem config, pgEnabled()=false e os handlers usam o Directus. Só escreve dados de máquina (enriquecimento) — não precisa dos hooks/validação do Directus.

**Exports:** `pgEnabled()` · `getPool()` · `pgUpdateSite()` · `pgUpdateCompany()` · `pgCompanyContactKeys()` · `contactKey()` · `pgInsertContacts()` · `writeBehindEnabled()` · `pgFlushSites()` · `pgUpsertSite()` · `pgUpsertCompany()` · `pgEnsurePlatforms()` · `pgClose()` · `updateItemMaybePg()` · `wrapClientPg()`

### `lib/phone.js`
lib/phone.js Extração de telefones INTERNACIONAL (PT/NO/SE/FI/NL/…) com libphonenumber-js. Substitui as regexes só-PT antigas. Estratégia: 1. links tel: -> parse com o país por omissão do site (do TLD, senão ip_country) 2. candidatos de texto (sequências plausíveis de dígitos/espaços/(). +) -> parse Fica com os que `isValid()`; devolve E.164 + país ISO2.

**Exports:** `tldToCountry()` · `ccTldCountry()` · `extractPhone()` · `extractPhones()`

### `lib/qualify.js`
lib/qualify.js Qualificação v2, CONFIGURÁVEL (config/qualification.json). Um site é "qualified" se tiver ≥1 contacto de email (has_email) E ≥1 sinal da lista signals_any. Substitui a qualificação só-por-plataforma (WP/Woo/Presta/Wix) anterior. Sinais avaliados a partir do registo do site (campos já existentes em `sites`):

**Exports:** `loadQualifyConfig()` · `qualify()` · `TARGET_PLATFORMS`

### `lib/ratelimit.js`
lib/ratelimit.js — rate-limit por chave (ex.: registry host) via Redis, PARTILHADO entre os workers de uma VM (cada IP tem o seu orçamento → a frota escala mantendo a educação). Janela fixa por segundo. FAIL-OPEN (Redis em baixo → deixa passar). Respeita Retry-After.

**Exports:** `acquire()` · `penalize()` · `penalized()`

### `lib/rdap.js`
lib/rdap.js Tier RDAP do WHOIS (Part B). RDAP (RFC 9083) = HTTP+JSON standardizado, grátis, distribuível por IP. Testado 2026-07-11: funciona p/ .no/.nl/.fi (registrar+created; SEM expiry — política dos registries); .pt/.se NÃO têm RDAP público (→ router cascata). Devolve a MESMA shape que lib/whois.js p/ o router poder cascatear sem os handlers mudarem.

**Exports:** `tldOf()` · `rdapKnown()` · `lookupRdap()`

### `lib/reacher.js`
lib/reacher.js — Fase 1 (validação de emails). Wrapper do motor Reacher (self-hosted, HTTP) que faz o handshake SMTP via os NOSSOS proxies SOCKS5 limpos (Dante em VMs datacenter com PTR alinhado). O Reacher aceita `proxy` + `hello_name` por pedido, por isso cada verificação sai de um IP de validação — nunca desta máquina. A orquestração (prefilter barato, routing por provider, resume no Directus) fica em verify-emails.js. Este módulo: chama o Reacher, mapeia a resposta para o nosso vocabulário `email_status`, e gere a rotação de proxies + cooldowns por IP/provider. Ver docs/outreach-ops/02-reacher.md e 01-validation-fleet.md.

**Exports:** `providerClass()` · `mapReacher()` · `checkEmail()` · `makeReacherPool()` · `isBigProvider`

### `lib/stripe.js`
lib/stripe.js — núcleo do cliente Stripe (Fase F, sem feature). Port do netmaster, com o toggle sandbox/live via env (STRIPE_MODE=live → LIVE_*, senão TEST_*) em vez do Directus. getStripeClient() devolve a instância do SDK. Fail-soft: stripeEnabled().

**Exports:** `stripeEnabled()` · `getStripeClient()` · `isStripeConfigured`

### `lib/subdomains.js`
lib/subdomains.js Descoberta de subdomínios MULTI-FONTE com fallback. O crt.sh (PG público) é cronicamente instável/em-baixo → certspotter (CT log, grátis) passa a fonte primária, com crt.sh (HTTP + PG), SecurityTrails e Censys como fontes adicionais (as duas últimas gated em API key), e subfinder (CLI, agrega dezenas de fontes) se instalado. Faz-se merge + dedup de tudo o que responder; uma fonte a falhar NÃO derruba as outras. Só se TODAS falharem (rede/rate-limit) é que lança (nak/retry). Egresso: os fetches usam o dispatcher do egress (EGRESS_PROXY → exit node residencial) quando ativo.

**Exports:** `discoverSubdomains()`

### `lib/verify-core.js`
lib/verify-core.js Núcleo PARTILHADO de verificação de email por domínio — usado tanto pelo verify-emails.js (standalone) como pelo handler `verify` do worker distribuído (worker/handlers.mjs → jobs.verify). Uma decisão de catch-all por domínio; routing big-provider→API-first / corporativo→Reacher-first; persiste em Directus. Capacidade: a quota free (QEV 100/dia, etc.) esgota-se. `hasCapacity()` diz se ainda há verificador disponível; verifyDomain LANÇA quando fica sem quota a meio (em vez de marcar tudo 'unknown'), para o job voltar à fila (nak) e os contactos não-processados ficarem com email_status=null → re-enfileirados no lote seguinte.

**Exports:** `makeVerifyOne()` · `verifyDomain()` · `hasCapacity` · `class PoolExhaustedError`

### `lib/verify-providers.js`
Pool de contas de APIs de verificação de email (free-tier), com rotação de contas + de proxies, para MAXIMIZAR os limites gratuitos. Config em config/verify-providers.json (GITIGNORED). Cada entrada: { "provider": "quickemailverification", "apiKey": "K", "dailyLimit": 100 } { "provider": "mailboxlayer", "apiKeys": ["K1","K2"], "dailyLimit": 100 } // MULTI-KEY { "provider": "eva" } // keyless (free) Multi-key: `apiKeys:[...]` expande em várias contas (mais quota free). Providers keyless (eva/disify) não precisam de chave — a quota é por IP, por isso beneficiam do ROUTING por proxy (uma quota por IP). Ver config/verify-providers.example.json. Routing por proxy (opcional): rota HTTP dos pedidos por proxies (undici ProxyAgent) para os providers limitados por IP terem uma quota free por proxy. Lê o campo `http` (ex. "http://user:pass@p1.dominio:8888") das entradas de config/verify-proxies.json; SOCKS5 puro não é suportado por fetch (usar um proxy HTTP nas VMs — ver docs). verify(email) → { status, provider } ou null (pool esgotado). status normalizado: valid \| invalid \| catch_all \| disposable \| role \| unknown

**Exports:** `makeProviderPool()`

### `lib/whois-providers.js`
lib/whois-providers.js Tier WhoisXML do WHOIS (Part B) — best-effort p/ .pt (sem RDAP + port-43 filtrado por IP) e fallback p/ expiry onde RDAP/port-43 não dão. Multi-key round-robin (free = 1000/mês/key → várias contas), grátis. Config gitignored `config/whois-providers.json` ou env WHOISXML_API_KEYS (csv). INERTE sem keys (whoisXmlEnabled()=false → o router salta o tier).

**Exports:** `whoisXmlEnabled()` · `lookupWhoisXml()`

### `lib/whois.js`
lib/whois.js — ROUTER de WHOIS (Part B), tiered por-TLD. Escolhe a via por TLD (evidência live 2026-07-11): .nl/.no/.fi → RDAP (grátis, JSON, sem expiry); .se → port-43 whoiser (dá registrar+created+EXPIRY); .pt → WhoisXML best-effort (sem RDAP; port-43 filtra IPs de datacenter). Cascata: um tier sem dados → o próximo. LANÇA em rate-limit (429/503) se TODOS os tiers rate-limitarem → o job faz nak+backoff. Todos os tiers devolvem a MESMA shape {registrar,created,expiry,ageDays,expiringSoon}.

**Exports:** `lookupPort43()` · `lookupWhois()`

### `lib/wise.js`
lib/wise.js — núcleo do cliente Wise (transferências). Port do netmaster, toggle via env (WISE_MODE=live → api.wise.com, senão sandbox). Bearer token. Fail-soft. Nota: iban/bic/accountHolder são detalhes de payout (não exigidos para as chamadas).

**Exports:** `getWiseConfig()` · `wiseEnabled()` · `wiseCall()` · `isWiseConfigured`

### `lib/with-retry.js`
lib/with-retry.js — retry com backoff exponencial p/ integrações Google/Notion. Port do netmaster (sem deps). Predicados: isGoogleRetryable / isNotionRetryable / notionRetryAfterMs (honra o header Retry-After do Notion).

**Exports:** `withRetry()` · `isGoogleRetryable()` · `isNotionRetryable()` · `notionRetryAfterMs()`

### `lib/wordfence.js`
lib/wordfence.js Wordfence Intelligence — base de vulnerabilidades WordPress LOCAL. Enriquece a enumeração KEYLESS do wpscan (plugins/temas/versão) com vulns conhecidas SEM gastar a quota da WPScan API (25/dia/key). A API v3 exige Bearer token (WORDFENCE_API_KEY — registo grátis em https://www.wordfence.com/products/wordfence-intelligence/). O updater (update-wordfence.js, agendado a cada WORDFENCE_UPDATE_DAYS) descarrega o feed 'production', constrói um índice COMPACTO por (tipo, slug) e guarda-o gzip em MinIO (reports bucket, objeto wordfence/index.json.gz). Os workers carregam-no (cache 6h) e fazem match. Env-gated: sem índice em MinIO, matchWpscanVulns devolve null (no-op — keyless na mesma).

**Exports:** `updateWordfenceDb()` · `matchWpscanVulns()`

### `lib/worker-telemetry.js`
lib/worker-telemetry.js — telemetria de workers via Redis (fail-soft). Cada worker regista-se (heartbeat) e conta jobs (ok/falha) + duração por consumer, e guarda as últimas linhas de log — para o dashboard mostrar workers a correr, a tarefa atual, contagens 1h/24h, durações e logs, sem depender do socket do Docker. REDIS_URL vazio → no-op (o worker corre na mesma). Chaves (TTL p/ auto-limpeza): np:wk:<id> HASH {id, role, host, started, pid, beat, cur, cur_started, cur_role} np:wk:index ZSET id -> last beat (para listar/expirar workers mortos) np:wk:<id>:done:<h> / :fail:<h> counters por HORA (epoch-hour), EXPIRE 26h np:wk:<id>:dur LIST últimas N durações (ms) p/ média np:wk:<id>:log LIST últimas N linhas de log (mais recente à cabeça)

**Exports:** `startTelemetry()` · `taskStart()` · `taskEnd()` · `logLine()` · `redisClient()` · `telemetryEnabled`


## lib/audit/ — jobs de auditoria

### `lib/audit/cpanel.js`
lib/audit/cpanel.js Deteta alojamento cPanel/WHM a partir de sinais que o enrich já tem em mãos (PTR, headers, Set-Cookie, URL final). Sinais "fortes" (cookie cpsession, portas 2082-2096, PTR de servidor de partilha) confirmam; LiteSpeed sozinho é só um indício fraco (muito comum em cPanel mas também fora dele) e não confirma.

**Exports:** `detectCpanel()`

### `lib/audit/emailauth.js`
lib/audit/emailauth.js Verifica SPF (TXT do apex) e DMARC (TXT de _dmarc.<domínio>) via DNS. Estados: ok / weak / missing / invalid. Falha de resolução transitória (SERVFAIL/timeout) devolve `null` (desconhecido) — o caller NÃO grava, para não marcar falsamente "missing". Cache por domínio (o mesmo apex repete-se).

**Exports:** `checkSpf()` · `checkDmarc()` · `checkEmailAuth()`

### `lib/audit/gmb-lookup.js`
lib/audit/gmb-lookup.js Google My Business via BROWSER (sem Places API) — fonte de verdade da localidade QUANDO encontra. Best-effort e frágil: o Google pode bloquear/mudar o HTML e mostrar consent walls. Degrada para o sinal on-site (lib/audit/gmb.js) quando não encontra. Rate-limit próprio. ESTRATÉGIA (validada com dados reais — evita falsos positivos por IDENTIDADE, não pela query): · A pesquisa por DOMÍNIO não resolve em headless (0/6, nem a Livraria Lello) → NÃO se usa. 1. MORADA (se o site tiver morada rua+nº): pesquisa a morada e clica num negócio de "Neste local" (âncora FÍSICA — o negócio está mesmo naquela morada). Guarda leniente (aceita sem authority). 2. NOME (fallback, ~89% dos sites não têm morada): pesquisa nome+cidade, resolve a ficha (auto- redirect ou clica no 1.º resultado) e ACEITA SÓ SE o site do negócio no GMB (authority URL) bater com o domínio auditado — guarda ESTRITA. Assim clicar no 1.º resultado é seguro: um negócio errado (ex.: grillsymbol.fi→homestagingportugal.com) é rejeitado por o site não bater.

**Exports:** `lookupGmb()`

### `lib/audit/gmb.js`
lib/audit/gmb.js Sinal ON-SITE de Google My Business (best-effort). NÃO é a fonte de verdade — na Fase 2 o `gmb-lookup` (browser) confirma e extrai a ficha. Aqui só detetamos indícios no HTML: link g.page / business.google, embed de Google Maps, place_id. A presença de JSON-LD LocalBusiness é um indício fraco (a empresa é local, mas pode não ter ficha Google).

**Exports:** `detectGmb()`

### `lib/audit/industry-heuristic.js`
lib/audit/industry-heuristic.js Classificador de ÁREA DE ATIVIDADE por keywords ponderadas — substituto do Ollama para o batch. O Ollama em CPU levava 107 s/site (26 dias p/ os 729k) e roubava CPU ao Lighthouse. Isto é ~instantâneo, corre no role `base` (network-bound, sem GPU) e é "bom o suficiente" para SEGMENTAR (que é o uso: filtrar audiências, não uma verdade legal). Mesma TAXONOMY e mesmo output ({ industry, confidence }) do classificador Ollama → drop-in. Método: conta ocorrências das keywords de cada categoria no título+descrição+texto (o título pesa mais). Devolve a categoria com mais pontos; confiança = margem sobre a 2.ª. Sem sinal forte → 'outros' com confiança baixa. Palavras acentuadas e não-acentuadas ambas cobertas.

**Exports:** `industryFromGmbCategory()` · `classifyIndustryHeuristic()`

### `lib/audit/jsonld.js`
lib/audit/jsonld.js Parser best-effort de blocos <script type="application/ld+json"> — usado pelos módulos de auditoria barata (localidade, GMB). Achata @graph e objetos aninhados para que o consumidor encontre um nó por @type sem descer a árvore à mão.

**Exports:** `parseJsonLd()` · `typesOf()`

### `lib/audit/lighthouse.js`
lib/audit/lighthouse.js Lighthouse (config mobile por omissão) contra o Chromium partilhado via chrome-launcher. Deriva seo_score + mobile_score + mobile_friendly e guarda o lhr completo em site_reports(kind:'lighthouse_*'). ~25-35s/site.

**Exports:** `runLighthouse()` · `lighthouseSummary()` · `trimLhr()` · `leanLhr()`

### `lib/audit/load.js`
lib/audit/load.js Tempo de carregamento (time-to-last-byte da homepage) → balde fast/medium/slow/ very_slow. `bucketLoad(ms)` é puro (reutilizado no enrich, que já cronometra o fetch de liveness); `measureLoad(url)` faz um fetch dedicado para o backfill.

**Exports:** `bucketLoad()` · `measureLoad()`

### `lib/audit/locality.js`
lib/audit/locality.js Extrai a localidade do NEGÓCIO (cidade/região/morada) do HTML — distinta do `ip_city` (cidade do ALOJAMENTO). Ordem: JSON-LD PostalAddress → <address> → código postal PT (\d{4}-\d{3} cidade) por linha, que também preenche a morada. Best-effort; cobertura parcial. Quando existir GMB essa é a fonte de verdade.

**Exports:** `extractBusinessLocation()`

### `lib/audit/nuclei.js`
lib/audit/nuclei.js Scanner de segurança do BATCH (ProjectDiscovery Nuclei, sem limite de API). Corre em todos (qualificados→resto). Conta findings por severidade e devolve o máximo. Guarda-se depois em site_reports(kind:'nuclei'). O WPScan fica só p/ on-demand (25/dia).

**Exports:** `nucleiTagsForTech()` · `runNuclei()`

### `lib/audit/ollama-classify.js`
lib/audit/ollama-classify.js Classifica a ÁREA DE ATIVIDADE do negócio via Ollama (Gemma) com saída JSON estruturada (`format` = JSON schema) e uma taxonomia PT fixa. Input = título + meta description + ~600 chars visíveis. gemma3:4b p/ qualificados/on-demand; gemma3:1b (env OLLAMA_MODEL) p/ a cauda longa.

**Exports:** `summarizeForClassify()` · `classifyIndustry()` · `TAXONOMY` · `warmup`

### `lib/audit/social.js`
lib/audit/social.js Extrai o primeiro perfil "real" de cada rede social do HTML (homepage + páginas de contacto). Exclui links de partilha/intent/plugins (share, sharer, intent, ...), que não são a presença da empresa mas sim botões de partilha. Redes: facebook, instagram, linkedin, twitter/x, youtube, tiktok, pinterest, whatsapp. WhatsApp é sinal ALTA-prioridade para PMEs (PT): capturamos presença + número.

**Exports:** `extractSocial()` · `socialFlags()`

### `lib/audit/ssllabs.js`
lib/audit/ssllabs.js Análise PROFUNDA do SSL via Qualys SSL Labs API v3. Complementa o job `ssl` (que já captura emissor/grade/dias/validação/wildcard num handshake rápido): o SSL Labs avalia a CONFIGURAÇÃO (protocolos, cifras, cadeia, Heartbleed/ROBOT/etc.) e dá uma nota A+…F com avisos. LENTO (~1–3 min/host) e RATE-LIMITED (máx ~7 assessments concorrentes por IP, cool-off 1s). Só faz sentido on-demand (botão no drawer) ou num batch PEQUENO de leads de topo — nunca a base toda.

**Exports:** `analyzeSslLabs()`

### `lib/audit/tranco.js`
lib/audit/tranco.js Tráfego (proxy) via ranking Tranco top-1M. Carrega o CSV uma vez para um Map (~150MB) e devolve rank+balde. A maioria dos domínios de países pequenos fica `unranked` (= sem dados, não "pouco tráfego"). CSV via fetch-tranco.js.

**Exports:** `loadTranco()` · `bucketOf()` · `trafficOf()`

### `lib/audit/wpscan.js`
lib/audit/wpscan.js SÓ on-demand (botão "Auditar agora" no drawer), para sites WordPress. Token grátis = 25/dia → nunca em batch (o batch de segurança é o Nuclei). Devolve o nº de vulnerabilidades + o relatório completo (guardado em site_reports).

**Exports:** `runWpscan()`


## worker/ — o worker

### `worker/handlers.mjs`
worker/handlers.mjs Handlers FINOS (Fase B) — um por passo. Cada um lê os seus inputs (snapshot do MinIO ou a linha do site no Directus), escreve os seus campos e PUBLICA os sucessores (DAG orientado a eventos, sem orquestrador central). DAG: fetch ──▶ {geoip? via dns} · fingerprint · social · locality · contacts · industry · traffic · emailauth dns ──▶ geoip (qualquer passo que mude sinais) ──▶ score score (qualificado, 1.ª vez, AUDIT_ENABLED) ──▶ {lighthouse.mobile, nuclei, ssl, whois, dnsprovider, (gmb)} Reutiliza as funções puras de lib/* já existentes.

**Exports:** `makeFineHandlers()`

### `worker/tracing.mjs`
NetProspect — bootstrap de tracing OpenTelemetry para os WORKERS. Carregado antes do worker via `node --import ./worker/tracing.mjs worker/worker.mjs` (ver worker/Dockerfile). Exporta OTLP para o Jaeger (np-server, via tailnet). Ver docs/observability.md. OPT-IN: só ativa com OTEL_ENABLED=1 (os workers fazem MUITO HTTP de saída → amostragem baixa via OTEL_TRACES_SAMPLER_ARG). FAIL-SOFT: se as libs/colector falharem, o worker corre na mesma.


### `worker/worker.mjs`
worker/worker.mjs Worker replicável da pipeline NetProspect. Liga-se ao NATS JetStream, garante a topologia (stream + consumers) e consome os jobs, despachando por subject: jobs.enrich -> enriquecer domínio (DNS/IP/geo/tech/liveness + auditoria barata) jobs.contacts -> extrair contactos-pessoa do site jobs.audit.* -> auditoria pesada (Lighthouse/Nuclei/Tranco/Ollama/GMB/WPScan) Encadeamento (DAG pela própria fila): enrich concluído -> se qualificado publica jobs.contacts (+ jobs.audit.qualified quando AUDIT_ENABLED); senão jobs.audit.rest. Auditoria: drain por PRIORIDADE ondemand -> qualified -> rest (o "Auditar agora" salta à frente do batch). WPScan só em jobs on-demand + WordPress. Escala: `docker compose up -d --scale worker=N`. Concorrência interna por env.


