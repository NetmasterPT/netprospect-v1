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
    - [ ] AND, OR, AND+OR em vez de ser só AND — **adiado**: refactor do motor de filtros (Directus `_and`/`_or` aninhados em `buildSiteFilters`/`siteFilterParts`) + UI de grupos; precisa de teste ao vivo
    - [ ] SSL Providers not free — **bloqueado**: não guardamos o emissor do certificado (só `ssl_grade`/`ssl_days_left`). Precisa de capturar o issuer no job SSL primeiro
    - [x] Email auth SPF+DMARC option (opção "SPF e DMARC (ambos)")
    - [~] Na Infra outras infras além de cPanel — adicionado "Sem cPanel"; outros painéis (Plesk/DirectAdmin) precisam de deteção no fingerprint
    - [x] No Social: Whatsapp, Pinterest, YouTube, TikTok
    - [x] Na qualidade <40 e intervalos (lead_max `< 40/50/60` + combina com ≥ para intervalo)
    - [ ] Na plataforma WP+WooCommerce juntos — **a decidir**: `primary_platform` é 1 valor (Woo já implica WP); precisa de filtro por `tech_detected` contém ambos, ou clarificar
    - [x] Na Auditoria Desktop não friendly (proxy: `perf_desktop < 50`; não há coluna `desktop_friendly`)
    - [ ] Na Actividade mais categorias — **bloqueado**: as categorias vêm da taxonomia do classificador (22 fixas em `lib/audit/industry-heuristic.js` + AGENT_TAXONOMY); adicionar na UI só faz sentido depois de expandir a taxonomia
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



- [x] Página **Cobertura de Dados** (`#/data-coverage`) — cobertura de cada TIPO DE DADO no dataset (o
  campo tem valor), distinta da "Cobertura de jobs" (o job correu). `/api/data-coverage` + `DATA_COVERAGE_SQL`.

> **Directory** — o grosso ficou feito (ver a secção Directory acima). Adiados com o porquê: **AND/OR**
> (refactor do motor de filtros, precisa de teste ao vivo), **SSL not-free** (falta guardar o issuer do
> certificado), **WP+Woo juntos** (a decidir), **mais categorias** (expandir a taxonomia do classificador).