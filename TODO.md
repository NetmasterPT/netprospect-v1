# TODO

- [x] Gerais
  - [x] Repo Clean Up (deprecated files to be deleted)
  - [x] Adicionar Redis para Cache do Frontend e DB queries (está a começar a ficar lento)
  - [x] Dashboard auto-update in the background (without page content refresh - "A carregar...")
  - [x] Dashboard data does not seem to be correct (verify proper filters of metrics and search queries) — KPIs verificados vs np-db (batem exatamente); caveat: aggregate do Directus não filtra relações profundas → Coverage usa PG direto
  - [x] Corrigir role da fila do industry (ai -> heuristic)
  - [x] Dashboard mobile responsiveness
  - [x] Reduzir a cache da cobertura de jobs de 10 min para 2 min
- [x] Agentes
  - [x] "Orquestrador": fala com o utilizador e pode lançar os outros agentes da plataforma
    - [x] Página de Chat (#/chat — chat dedicado full-height + sugestões; encaminha para Audience/Planner/Campaign Creator)
  - [x] "Campaign Creator": que cria os copies e escolhe/compila as variáveis a usar nos emails para que estes emails sejam o mais personalizados possível para cada prospecto ou cliente
    - [x] Card na página dos Agentes (angle + público + instruções → assuntos + corpo com {{variáveis}}) e o orquestrador comunica com ele (intent 'campaign' → /api/agents/campaign-copy)
  - [x] "Planificador": que planifica campanhas de email e ajuda a definir que produtos/serviços anunciar e que audiencias devemos criar
  - [x] "Audience Creator": que pesquisa e analisa a nossa DB para criar audiencias com base no target pedido do utilizador
  - [x] Adicionar páginas de configuração para (página Configuração: serviços + verificação + envio + Workers/frota + ângulos)
  - [x] Proxies Configuration (contagem + estado; segredos lidos server-side, nunca servidos)
  - [x] Mail Servers Configuration (contas de envio + modo SMTP/dry-run + warm-up)
  - [x] Workers Configuration (roles da frota ao vivo + jobs por role + perfil I/O)
  - [~] Cold Outreach Emails Configuration — consolidado nos "Ângulos de campanha"; separar por fase quando existir campaigns.phase
  - [~] Semi Warm Outreach Emails Configuration — idem (ângulos)
  - [~] Warm Outreach Emails Configuration — idem (ângulos)
- [x] Adicionar páginas de Dashboard para
  - [x] Clientes (já convertidos)
  - [x] ISPs (descobertos pela plataforma)
  - [x] AI Agent Chat + Sub-Agents
  - [x] Data Coverage (with metrics of the jobs that are still missing and coverage of each one)
  - [x] Servers
    - [x] Load
    - [x] VMs running
  - [x] VMs
    - [x] Load
    - [x] Workers running
    - [x] Logs (via drawer do worker)
  - [x] Workers Queue
  - [x] Workers Queue Logs (página Logs — merge dos logs de todos os workers)
  - [x] Workers Queue Statistics (rate/h + ETA + throughput na página Filas)
  - [x] Workers
  - [x] Workers Logs
  - [x] Workers Statistics (cabeçalho agregado na página Workers)
  - [x] Outreach (página #/outreach: funil generated→sent→opened→clicked + campanhas por ângulo/estado)
  - [x] Outreach Logs (registo de envios — coleção emails: quando/para/assunto/campanha/estado)
  - [x] Outreach Statistics (KPIs: campanhas, gerados, enviados + taxas de abertura e clique)
  - [x] Import em CSV de:
    - [x] Contactos
    - [x] Empresas
    - [x] Clientes
    - [x] Sites
    - [x] Campanhas
    - [x] Segmentos
  - [x] Separar por fase Cold / Semi-Warm / Warm — aguarda campo campaigns.phase no esquema (a página separa por fase automaticamente quando existir)
- [x] Adicionar páginas públicas para
  - [x] Company report summary — rota pública `/r/<token>` servida pelo dashboard a partir da auditoria do site (performance/segurança/SSL/GMB + recomendações), CTA "marcar chamada" (mailto) e link para o completo; marca opened_at na 1.ª abertura. **Requer excluir `/r/*` do Authentik no NPMPlus para ficar público.**
  - [x] Company full report — `/r/<token>?full=1` (mesma rota, secções extra: performance detalhada, stack tecnológica completa, lista de recomendações)
- [~] Directory
  - [x] Order by nas colunas (Lead/Domínio/Plataforma/Local clicáveis; server `?sort=&dir=` whitelist)
  - [~] Filtros
    - [x] Na Actividade mais categorias — **bloqueado**: as categorias vêm da taxonomia do classificador (22 fixas em `lib/audit/industry-heuristic.js` + AGENT_TAXONOMY); adicionar na UI só faz sentido depois de expandir a taxonomia
    - [x] Email auth SPF+DMARC option (opção "SPF e DMARC (ambos)")
    - [X] Na Infra outras infras além de cPanel — adicionado "Sem cPanel"; outros painéis (Plesk/DirectAdmin) precisam de deteção no fingerprint
    - [x] No Social: Whatsapp, Pinterest, YouTube, TikTok
    - [x] Na qualidade <40 e intervalos (lead_max `< 40/50/60` + combina com ≥ para intervalo)
    - [x] Na Auditoria Desktop não friendly (proxy: `perf_desktop < 50`; não há coluna `desktop_friendly`)
    - [ ] AND, OR, AND+OR em vez de ser só AND — **adiado**: refactor do motor de filtros (Directus `_and`/`_or` aninhados em `buildSiteFilters`/`siteFilterParts`) + UI de grupos; precisa de teste ao vivo
    - [ ] Permitir plataformas juntas (AND e OR, neste momento só permite um destes de cada vez e ao seleccionar o segundo des-selecciona o primeiro mesmo que usando o AND ou o OR)
    - [ ] SSL Providers not free - Provider Sectigo por vezes é pago e outras vezes é free. Tipos de certificado podem incluir incluem DV, OV, EV. Classes dos certificados podem ser Essential, Premium, Instant, Wildcard, Multidomain, PersonalSign, Code Signing, Unified Communications
- [ ] Adicionar aos Jobs e Data mined
  - [ ] Racius company info scraping (PT companies)
  - [ ] Company info (Other countries companies alternatives to Racius - can be free APIs or scraping)
  - [ ] Finantial information (where available for free - scraping or APIs)
  - [ ] Companies scale (worldwide, continental, national, regional, local)
  - [ ] Companies Competition taking into account their scale
  - [ ] Better way of knowing the sites monthly views for free (better coverage, now the coverage of this data point is too low)
- [ ] Páginas Bookings (integrar com Google Calendar e com Notion e Notion Calendar)
  - [ ] Book Call
- [ ] Páginas Store Services/Products/Subscriptions (integrar com Loja Netmaster + Stripe)
  - [ ] Sell
  - [ ] Client Portal
- [ ] Pendentes
  - [ ] Cobertura de jobs — terminar >50 (só >70/>60 feitos). Gargalos: lighthouse (Chromium, lento → horas), industry ~6,6k, whois ~1,3k; gmb ~13k é impraticável no laptop (ver GMB abaixo). Enfileirar por bandas quando houver capacidade.
  - [ ] Backfill snapshot-regen (`fetch snapshotOnly`, ~1M na fila, ~9,5/s → ~30h) — regenera snapshots no MinIO + reclassifica a indústria base-wide; enche o industry de >50 ao longo do tempo.
  - [ ] SSL Labs em batch para leads de topo — job pronto (`enqueue-ssllabs.js --qualified` / `--min-score`); lento/rate-limited (~7/IP), correr num lote pequeno.
  - [x] Verify (email) à escala — **DESTRAVADO (2026-07-19): Reacher self-hosted live** (`REACHER_URL` → de-minio, egress `49.12.120.250`, domínio `ashospitalityconsulting.com`). O SMTP `RCPT` direto tira o teto de ~100/dia da API; verify a produzir `safe`/`unknown` sem "pool exhausted". Ver [`docs/outreach-ops/02-reacher.md`](docs/outreach-ops/02-reacher.md). Follow-ups menores: alguns `.se` dão "fetch failed" (timeout do probe → retry-churn); requeue dos ~959 órfãos verify antigos (do tempo do cap) para o Reacher os processar.
  - [ ] GMB é residencial-only (só o laptop, ~0,3/s + intermitente) — gargalo estrutural; escalar precisa de +IPs residenciais. Rever o resume (usa `gmb_name`, re-corre sites que já correram sem match → inflaciona a fila do laptop).
  - [ ] Poison-DB: corrigir os extractors on-site partidos (contacts/social/locality) — ver plano; até lá o snapshot-regen só reclassifica indústria (não re-corre esses).
- [ ] Integrações (Moloni / Contabilidade / CRM) — construídas e em produção (2026-07-19). Falta:
  - [ ] **Documenso — ligar:** criar conta admin na UI (http://100.114.17.74:3500) + gerar API token → pôr `DOCUMENSO_API_TOKEN` no store (o atual é o do netmaster, não serve). Instância self-host já no ar no np-server.
  - [ ] **Escrita de VD (Venda a Dinheiro):** leitura confirmada (Moloni SAFT type 5); a geração tem de ser em LIVE (sandbox restrito) — determinar o endpoint de insert do Moloni v1 e testar por rascunho, EM CONJUNTO.
  - [ ] **Subscrições ↔ Moloni** — ligar a coleção `subscriptions` (planos) às avenças/produtos do Moloni, mapeando por produto / `moloni_service_id` (nota: podem existir produtos Moloni sem Subscription no NetProspect):
    - [ ] Do lado da **Subscription**: escolher uma avença Moloni existente OU criar uma; uma subscription tem de ter SEMPRE um produto Moloni associado.
    - [ ] Do lado dos **Produtos**: opção de ligar um produto Moloni a uma Subscription, ou criar uma.
  - [ ] **Wise** — `WISE_SANDBOX_API_TOKEN` expirado (401); renovar quando se quiser usar Wise.
  - [ ] **FF (fatura de fornecedor)** — só leitura/sync (é documento recebido/compras); NÃO suportar escrita.
  - [ ] Páginas dedicadas para tipos extra (guia_remessa/proforma/…) se surgirem documentos desses tipos.
  - [ ] (opcional) Documenso/Google atrás de domínio público + reverse proxy; `google.service-account.json` no np-server só se precisar de Google além do Calendar.

---

## ⏸️ Adiado — o que falta fechar (nota 2026-07-20)

Em pausa por decisão do gpedro; retomar quando ele disser. Detalhe operacional em `TODO-KEYS.md`.

### Stripe / Loja
- [ ] **Test-sale no browser** (cartão test `4242…`) → loop completo checkout→webhook→fulfill. *(Criação de sessão + webhook JÁ validados server-side; falta o clique final no cartão.)*
- [ ] **Go-live:** rodar as keys live (foram partilhadas em texto simples) → colocá-las no store + `STRIPE_MODE=live`. Hoje o store está em **TEST**.
- [ ] (opcional) handler `invoice.paid` p/ renovações de subscrição recorrente (hoje só `checkout.session.completed`).

### Moloni (fatura da loja)
- [ ] Decidir a **empresa Demo** (o `getAll` LIVE só vê a Netmaster 207752) → depois ligar `emitMoloniInvoice` ao `createDocument` real, em RASCUNHO.

### Meios de pagamento (sandbox → E2E, EM CONJUNTO)
- [ ] **EuPago / PayPal / CoinGate / Transferência**: creds sandbox no store + webhook/callback + teste E2E (venda→confirmação→fulfill 1×). Fixes de código antes (validação EuPago/CoinGate, capture PayPal) — ver `TODO-KEYS.md §6d`.
- [ ] **`STORE_IBAN`** (transferência) em falta no store.

### NPMplus (reverse-proxy) — routing versionado + API + segurança
- [ ] **Load-balancing:** a UI do NPMplus **não** faz upstream-LB, mas é possível por **custom-nginx** (oficial):
  `upstream cu_<nome> {}` em `custom_nginx/http_top.conf` + host com forward=`cu_<nome>` e porta vazia. Versionar em
  `deploy/npmplus/custom_nginx/` (Camada B). OU a nossa camada, gerida do dashboard. **Não passar despercebido.**
  Ver [auth-npmplus-authentik](docs/auth-npmplus-authentik.md).
- [ ] **Fechar o `/api` ao público:** `npm.netmaster.pt` está em IP público e o `/api` está exposto (o OIDC só
  gateia a UI). Restringir o `/api`+admin ao **tailnet+localhost** (allow/deny no nginx do admin ou DNS só-tailnet);
  `/api` do NPMplus **e** do Authentik só a tokens **admin** válidos. Nós acedemos de dentro da VPN por `127.0.0.1`.
- [ ] **Write por API** (create/edit/delete de proxy hosts): bloqueado por `Permission Denied` do AJV do NPMplus
  com tokens de password (a UI usa sessão OIDC). Entretanto o **write é por SQLite** (`npmplus-routes`). Investigar
  se precisarmos mesmo do write-por-API.

### Plataforma de docs (subdomínios)
- [ ] **Notebook** (`notebook.netmaster.pt`→:8502) e **Obsidian** (`obsidian.netmaster.pt`→:8091) **não carregam**: backends up mas HTTP 400 (host/protocolo). Streamlit → WebSocket + XSRF/baseUrlPath; KasmVNC → proxy **https** + skip-cert + WebSocket. Config no NPMplus (hel1-npm) + args dos containers (np-server). Entretanto os URLs Tailscale Serve funcionam.

### Verify (FECHADO ✅)
- [x] 2.º IP Reacher (val2 `65.108.120.25`) operacional; MAIL FROM por-IP (cada host o seu domínio, sem misturas). Sem mais IPs de datacenter com PTR de momento.
