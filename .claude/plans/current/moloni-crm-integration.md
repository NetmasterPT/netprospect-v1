# Plan: Integração Moloni + camada de integrações (CRM/contabilidade) no dashboard

> Sessão: NetProspect DEV Integrations. Ficheiro próprio (isolado do `linear-weaving-quail.md`, de outra sessão).

## Context

Integrar no dashboard do NetProspect: (1) a **API do Moloni** (contabilidade PT) — páginas no CRM, backfill de
clientes, sync de Serviços→`subscriptions`/Produtos→`products`, e **leitura+escrita completa** (gerar **todos** os
tipos de documento, adicionar/editar clientes e documentos, **download** de PDFs); (2) um sistema de **Agendamentos**
que cria evento no **Notion** + no **Google Calendar** e os **liga** (para o Notion Calendar mostrar tudo); (3) uma
**camada de integrações** reutilizando os clients já testados do `netmaster-app`.

**Decisões:** API Moloni **clássica**; **leitura+escrita**; integrações → **"fundação agora"** (copiar creds + portar
os clients prontos; features por caso de uso depois). Reutilizar ao máximo o `/root/Github/netmaster-app`.

## Reutilização do `netmaster-app` (mesma máquina, TS/Feathers → portar p/ Node ESM)

- **Moloni** — `api/src/services/invoicing/moloni-client.ts` (OAuth2 password-grant+refresh self-healing;
  `moloniCall(path,body,opts)` com as 3 manhas: form-urlencoded, token na query, arrays PHP-bracket; descodifica 4
  formatos de erro) + `moloni.ts` (emissão FR/CN, `exemption_reason:'M99'`, `taxes[]`, `fetchPdfBuffer` p/ download).
  Lição `.claude/lessons/api/moloni/SKILL.md`. → **portar** p/ `lib/moloni.js`.
- **Booking Notion+GCal** — `api/src/services/booking/{booking.ts,google-calendar.ts,notion.ts}` (ver Agendamentos).
- **Clients de integração** (portar p/ `lib/`): `notion.ts`, `google-calendar.ts`(+auth SA), `stripe.ts`, `paypal.ts`,
  `eupago.ts`, e `.sandcastle/lib/content/brevo.ts` (ESM).

**Findings NetProspect:** dashboard SPA `dashboard/public/index.html` (`NAV_GROUPS` L359 CRM; `route()`; `viewX()`;
helpers `api/esc/eur/ic`, badges, drawers, `{rows,total,page,limit}` de `/api/contacts` L449) sobre **Directus**
(`d()`/`dwrite()` L74/L97). "clients"=`companies`(is_client). Colecções via `bootstrap-directus.js`. Upsert por chave
externa = ler-por-filtro→PATCH/POST. Segredos em `docker/.env`+`config/*.json`; cron via `verify-enqueue-cron`.

## Credenciais (reutilizar as do `netmaster-app/.env` — mesmas contas)

Copiar para o store `fleet-env/np-server` + `docker/.env` (mesmos nomes) + `google.service-account.json`:
- **Moloni** `MOLONI_*` (+`SANDBOX_MOLONI_*`) — mesma empresa (company_id, document_set_id, tax ids, `MOLONI_MODE`).
- **Google** `GOOGLE_SA_CLIENT_EMAIL`+`GOOGLE_SA_PRIVATE_KEY` (service-account, domain-wide delegation).
- **Notion** `NOTION_ACCESS_TOKEN`+`NOTION_DATABASE_ID`. **Stripe** test+live. **PayPal** sandbox+live.
- **EuPago** `EUPAGO_API_KEY`+`EUPAGO_WEBHOOK_V2_KEY`. **SMTP** `mail.netmaster.pt`.
⚠️ **env-reload:** após mudar `.env` usar `docker compose up -d --force-recreate` (o `restart` não recarrega).

---

## Moloni — modelo, sync, escrita, páginas

- **`lib/moloni.js`** (port de `moloni-client.ts`) + **`lib/moloni-sync.js`** (de `moloni.ts`: emissão, taxes, PDF).
- **Dados (`bootstrap-directus.js`):** `companies` +`moloni_customer_id`/`nif`; `subscriptions` +`moloni_service_id`;
  novas `products`, `moloni_documents` (unificada, `document_type` enum), `moloni_avencas`, `agendamentos`.
- **Sync (leitura):** `POST /api/moloni/sync?entity=…` upsert por `moloni_id`: customers→companies (match NIF→email→nome),
  products→products/subscriptions(por tipo), documentos→moloni_documents, avenças→moloni_avencas. Cron `moloni-sync-cron`.
- **Escrita (todos os tipos):** `POST/PATCH /api/moloni/{customers,products,documents,avencas}` → `<entity>/insert|update`
  (invoices, simplifiedInvoices, invoiceReceipts, receipts, creditNotes, debitNotes, supplierInvoices, estimates,
  deliveryNotes…). Payload comum: `document_set_id`, `customer_id`, `products[]` (`{name|product_id, qty, price,
  taxes:[{tax_id,value,order,cumulative}]}`), `status` 0=rascunho/1=fechado+AT+PDF. NC liga via `associates_documents`.
- **Download:** `GET /api/moloni/documents/:id/pdf` → `fetchPdfBuffer` (só `status=1`). Botão download + preview no drawer.
- **Páginas (menu "Contabilidade"):** Faturas, Recibos, Faturas-Recibo, Notas Crédito/Débito, Faturas de Fornecedores,
  Faturas-Recibo de Fornecedores, Avenças, Produtos — `viewX()` (copiar `viewContacts`) + `GET /api/moloni/<tipo>`.

---

## Agendamentos — sistema IGUAL ao `netmaster-app` (Notion + Google Calendar ligados)

Ao criar um agendamento no dashboard, replicar o fluxo de `booking.ts` (portar para Node ESM), na **ordem exata**:

1. **Google Calendar primeiro (âncora)** — `lib/google-calendar.js` `events.insert` no calendário do utilizador-alvo:
   `summary`, `description` (detalhes), `start/end` `{dateTime,timeZone}`, `attendees`, opcional `conferenceData`
   (link **Google Meet**, `conferenceDataVersion:1`), `sendUpdates:'all'`. Devolve `{id, htmlLink, meetLink}`
   (`requestId` do Meet calculado 1× → dedup em retry).
2. **Notion a seguir** — `lib/notion.js` cria página em `NOTION_DATABASE_ID` (via `data_source_id`): propriedade
   **date** (`{date:{start}}` → aparece nas vistas de calendário do Notion) + status; e no **corpo** um bloco
   "Meeting" com bullets-hyperlink: *Google Meet*→`meetLink`, *Calendar: Open event*→`htmlLink`.
3. **Ligar o Google de volta ao Notion** — `events.patch` anexa à descrição `Notion: <notionPageUrl>` (get-then-patch,
   `sendUpdates:'none'`, best-effort).

**Porquê funciona (o objetivo "Notion Calendar tem tudo"):** o **Notion Calendar** (app cron.com) sincroniza o Google
Calendar da equipa; o URL do Notion na descrição do evento → o Notion Calendar mostra-o como *Linked doc* (1 clique do
calendário para a página). A propriedade *date* da página → aparece também nas vistas de calendário nativas do Notion.
O evento GCal é a **âncora de verdade**; o URL Notion na descrição é a ponte bidirecional.

**Update/cancel (do netmaster-app):** `events.patch`/`events.delete` (trata 404/410 como sucesso — idempotente);
Notion `pages.update` (status) + **strikethrough** (re-escrever `rich_text` com `annotations.strikethrough`) ao
cancelar; nova secção "Meeting" ao re-agendar (preserva histórico). Gating `isCalendarConfigured`/`isNotionConfigured`.

**Complementos:** colecção nativa `agendamentos` (Directus) = registo do dashboard que dispara este fluxo; **Avenças**
(Moloni API) para o agendamento fiscal recorrente. O calendário nativo do Moloni **não é sincronizável** (só export
CSV) — mas a agenda unificada é totalmente atingida via **Notion+GCal**.

---

## Camada de Integrações — fundação (copiar/portar agora)

Portar para `lib/` os clients prontos + `lib/google-auth.js` partilhado (uma service-account serve Calendar/Drive/
Docs/Sheets/Slides/Gmail — alargar `SCOPES`). Deps no `package.json` (`@notionhq/client`, `googleapis`,
`google-auth-library`, `stripe`). Flags em `/api/config`.

| Integração | Origem netmaster-app | Creds lá | Decisão |
|---|---|---|---|
| **Notion** | `booking/notion.ts` (@notionhq) | ✅ | portar |
| **Google Calendar** (+auth SA) | `booking/google-calendar.ts` | ✅ (scope Calendar) | portar |
| **Stripe** | `payments/stripe.ts`(+webhook/refund) | ✅ test+live | portar núcleo |
| **PayPal** | `payments/paypal.ts`(+webhook/refund) | ✅ sbx+live | portar núcleo |
| **EuPago** | `payments/eupago.ts`+`webhooks/eupago.ts` | ✅ | **portar** (MB WAY/Multibanco/Payshop/PaySafeCard, API v1 form, webhook v1+v2 HMAC) |
| **Brevo** | `.sandcastle/lib/content/brevo.ts` (ESM) | ❌ | portar client + provisionar key |
| Gmail / Drive / Docs / Sheets / Slides | — (só SMTP; Sheets stub) | SA sem scopes | implementar (reusa SA) |
| Mailchimp / n8n | — | ❌ | implementar + provisionar |

## Outras integrações disponíveis no `netmaster-app` (resposta a "que mais existe?")

Todas com **credenciais presentes** e código testado — prontas a portar se/quando interessarem:
- **Pagamentos:** **CoinGate** (cripto), **Wise** (transferência IBAN), **Bank transfer** (instruções IBAN manuais),
  **Klarna** (código, mas `.env` vazio → precisa de creds).
- **Documenso** (assinatura eletrónica: template→documento→enviar→download PDF assinado + webhook) — útil p/ contratos/propostas no CRM.
- **OpenProvider** (registo de domínios + preços + certificados SSL) — complementa o enriquecimento de domínios/SSL do NetProspect.
- **WHOIS/RDAP** — o NetProspect já tem o seu (`lib/whois.js`/`rdap.js`/`whois-providers.js`: RDAP + WhoisXML + port-43;
  **não** suporta IP2WHOIS). O netmaster-app só tem **1 key WhoisXML + 1 key IP2WHOIS** → ganho modesto (~500–1000
  lookups/mês free-tier). **Ganho fácil:** copiar a **1 key WhoisXML** para o config do NetProspect (o `docker/.env`
  não tem nenhuma). **Opcional/baixa prioridade:** adicionar um adapter **IP2WHOIS** (portado) como fallback extra.
- **Authentik (SSO/OIDC) — FORA por agora** (decisão do utilizador: manter o setup tailnet-gated atual). Referência guardada.
- **Tailscale** — já usado na frota.
- **Sandcastle (automação de conteúdo, sem creds no `.env` — provisionar):** GitHub (creds ✅), LinkedIn, Meta (FB/IG),
  X, TikTok, **Google Gemini** (imagem/vídeo AI), **xAI Grok** (STT), **ElevenLabs** (TTS). Relevantes p/ outreach/conteúdo.

### DECIDIDO — a fundação inclui (além de Notion/Google/Stripe/PayPal/EuPago/Brevo):
- **Documenso** (e-sign) — `lib/documenso.js` (de `signing/documenso-client.ts`), creds ✅.
- **Pagamentos extra** — `lib/coingate.js`, `lib/wise.js`, `lib/bank-transfer.js` (de `payments/*`), creds ✅.
- **OpenProvider** — `lib/openprovider.js`+`lib/openprovider-ssl.js` (de `domains/*`), creds ✅.
- **Social/AI** — `lib/social/{linkedin,meta,x,tiktok}.js` + `lib/media/{gemini,grok-stt,elevenlabs}.js` (de
  `.sandcastle/lib/*`, já ESM). ⚠️ **sem creds no netmaster-app** → o utilizador **provisiona** as chaves
  (`LINKEDIN_*`, `META_*`, `X_*`, `TIKTOK_*`, `GEMINI_API_KEY`, `XAI_API_KEY`, `ELEVENLABS_API_KEY`).
- **WHOIS reforço (opcional, baixa prioridade):** copiar a 1 key WhoisXML para o config WHOIS existente do NetProspect
  (que não tem nenhuma); IP2WHOIS = adapter novo, adiado. **Authentik = FORA por agora** (manter tailnet-gated).

---

## Briefings de implementação (netmaster-app → NetProspect)

**Padrão comum de port:** os clients do netmaster-app são módulos TS em `api/src/services/*`. A **lógica low-level**
(fetch, auth, shaping do request) é **livre de Feathers/Directus** e porta 1:1 para `lib/*.js` (tirar os tipos TS,
manter a lógica). A **casca Feathers** (classe `find/create`) e as leituras de config via Directus passam a: config do
NetProspect (`lib/env.js` + `docker/.env` + store `fleet-env`) + **endpoints `/api/*` no `dashboard/server.mjs`** que
usam `d()`/`dwrite()`. Mantém-se `isXConfigured()`. Tokens rotativos → cache (memória/Redis).

- **Moloni** — *netmaster-app:* `moloni-client.ts` (`moloniCall`, OAuth password-grant+refresh) + `moloni.ts`
  (emissão FR/NC, `ensureMoloniProduct`, `fetchPdfBuffer`), disparado no post-payment de uma encomenda. → *NetProspect:*
  `lib/moloni.js` + `lib/moloni-sync.js`; **não** só emitir na venda — **sync bidirecional completo** (todas as
  entidades) + páginas no CRM + escrita de **todos** os tipos de documento + **download**.
- **Agendamentos (Notion+GCal)** — *netmaster-app:* `booking.ts` cria evento GCal (âncora+Meet) → página Notion (date +
  links no corpo) → `events.patch` mete `Notion:<url>` na descrição; cancel = delete + strikethrough. → *NetProspect:*
  mesmo fluxo (`lib/google-calendar.js`+`lib/notion.js`), disparado ao criar um registo em `agendamentos`
  (`POST /api/agendamentos`), com **vista de calendário** no dashboard.
- **Notion** — *netmaster-app:* `notion.ts` (@notionhq/client): schema por data-source + `PROP_ALIASES`, cria/atualiza
  páginas, blocos no corpo, strikethrough. → *NetProspect:* `lib/notion.js` (tirar os 2 helpers Directus); usado pelos
  agendamentos e (futuro) sync de leads/clientes p/ uma DB Notion.
- **Google (auth+Calendar)** — *netmaster-app:* JWT service-account + domain-wide delegation inline no
  `google-calendar.ts` (scope Calendar). → *NetProspect:* extrair o JWT p/ **`lib/google-auth.js`** partilhado (alargar
  `SCOPES` p/ Drive/Docs/Sheets/Slides/Gmail no futuro) + `lib/google-calendar.js`.
- **Stripe** — *netmaster-app:* `stripe.ts` (SDK): PaymentIntents/Customers/Subscriptions + webhook `constructEvent` +
  refunds; sandbox/live por flag Directus. → *NetProspect:* `lib/stripe.js` + `POST /api/webhooks/stripe` (raw body +
  assinatura) + página de pagamentos; modo por env.
- **PayPal** — *netmaster-app:* `paypal.ts` (fetch): OAuth client_credentials, orders create/capture, webhook verify,
  refunds. → *NetProspect:* `lib/paypal.js` (`getPayPalConfig/getAccessToken/paypalCall`) + webhook + página.
- **EuPago** — *netmaster-app:* `eupago.ts` (fetch, API v1 form): MB WAY/Multibanco/Payshop/PaySafeCard, webhook v1+v2
  HMAC, email de instruções idempotente. → *NetProspect:* `lib/eupago.js` + `POST /api/webhooks/eupago[/v2]` +
  referências MB/MB WAY nas páginas de pagamento.
- **Brevo** — *netmaster-app:* `.sandcastle/lib/content/brevo.ts` (ESM, fetch): campanhas de email + sync de audiências.
  → *NetProspect:* `lib/brevo.js` (quase drop-in) — **provisionar `BREVO_API_KEY`**; usado no outreach.
- **Documenso** — *netmaster-app:* `documenso-client.ts` (fetch, self-hosted): template→documento→enviar→download PDF
  assinado + webhook. → *NetProspect:* `lib/documenso.js` + enviar contratos/propostas a assinar a partir do CRM.
- **CoinGate / Wise / Bank transfer** — *netmaster-app:* `payments/{coingate,wise,bank_transfer}.ts` (fetch). →
  *NetProspect:* `lib/{coingate,wise,bank-transfer}.js` + métodos de pagamento; reembolsos manuais (como na origem).
- **OpenProvider (+SSL)** — *netmaster-app:* `domains/openprovider.ts`+`openprovider-ssl.ts` (fetch): domínios + certs.
  → *NetProspect:* `lib/openprovider.js`+`lib/openprovider-ssl.js`; complementa o enriquecimento de domínios/SSL por caso de uso.
- **Social/AI** — *netmaster-app:* `.sandcastle/lib/{social/*,media/*}.ts` (ESM, fetch): LinkedIn/Meta/X/TikTok, Gemini,
  Grok(STT), ElevenLabs(TTS). → *NetProspect:* `lib/social/*`+`lib/media/*` — **provisionar creds**; outreach/conteúdo por caso de uso.

## Fases

1. **A1 — Moloni cliente** (`lib/moloni.js` port + creds + smoke `companies/getAll`/`documentSets/getAll`).
2. **A2 — Modelo** (campos `companies`/`subscriptions` + colecções `products`/`moloni_documents`/`moloni_avencas`/`agendamentos`).
3. **A3 — Sync leitura** (`lib/moloni-sync.js` + `/api/moloni/sync` + cron).
4. **A4 — Páginas leitura** (páginas Moloni + drawers + **download PDF**).
5. **B — Escrita Moloni** (clientes/produtos → documentos de todos os tipos; rascunho→finalizar).
6. **F — Fundação de integrações** (paralelo): portar `lib/{google-auth,notion,google-calendar,stripe,paypal,eupago,
   brevo,documenso,coingate,wise,bank-transfer,openprovider,openprovider-ssl}.js` + `lib/social/*` + `lib/media/*`
   (Social/AI, com creds a provisionar) + copiar creds + deps (`@notionhq/client`,`googleapis`,`google-auth-library`,
   `stripe`) + `/api/config` flags por integração. Portar o *client* ≠ construir a *feature* (features por caso de uso).
7. **G — Agendamentos** (colecção + calendário no dashboard + fluxo **Notion+GCal ligados** portado de `booking.ts`;
   camada avenças via Moloni). Depende de F (Notion+GCal).

## Verificação

- **Moloni:** sync popula colecções (idempotente); páginas listam + download PDF (status=1); criar/editar cliente/produto/
  documento aparece no Moloni + re-sync; documento rascunho→finaliza.
- **Agendamentos:** criar 1 agendamento → evento no Google Calendar (com Meet) + página no Notion (com date + links no
  corpo) + descrição do evento com `Notion: <url>`; abrir o **Notion Calendar** → aparece com o linked doc; cancelar →
  evento apagado + página com strikethrough.
- **Fundação:** `isMoloniConfigured`/`isNotionConfigured`/`isCalendarConfigured` etc. verdadeiros; smoke de cada client.

## Notas / risco

- **Moloni:** `exemption_reason:'M99'`; `document_set_id`/série tem de ter os tipos ativados no Moloni UI (passo manual);
  `status=1` p/ PDF; `company_id` correto; descodificação de erros (1/2/4/5). Ver lição.
- **Google:** o mesmo SA serve todos os produtos, mas **Drive/Docs/Sheets/Slides/Gmail exigem ativar os scopes** no
  Workspace admin (domain-wide delegation) — passo de config antes de os usar.
- **Notion Calendar** é a app cron.com a sincronizar o Google Calendar da equipa (não é API) — a ligação faz-se pelo URL
  na descrição do evento, exatamente como o netmaster-app.
- **Portar ≠ feature:** os clients ficam prontos; cada integração nova (Gmail/Drive/Mailchimp/n8n/…) precisa de caso de uso.
- **Deploy:** `npm run bootstrap` cria colecções; dashboard+cron recriam-se pelo pull-agent; creds no store `fleet-env/np-server`;
  commit+push ao main. `up -d --force-recreate` ao mudar `.env`.
