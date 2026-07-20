# Plano — Fase 6: Client Portal + Store/Checkout + Sell

> Plano completo da Fase 6 (substitui o âmbito só-portal). 6a (portal read-only) é a base SEGURA; 6b (checkout
> Stripe) e 6c (sell) são a camada de pagamentos — construídas a seguir, com Stripe **hosted** (o cartão nunca
> passa pelo nosso servidor) e a **fatura fiscal sempre no Moloni** (SAF-T PT). Não overwrite — plano próprio.
> ⚠️ Segurança: o Claude CONSTRÓI o código; **nunca executa pagamentos reais**; 6b só em **Stripe test mode**
> até o gpedro validar. Ver [[phase6-store-stripe-portal-plan]], [[netprospect-integrations]].

## Dados — já existem (auditado)
`moloni_documents` (faturas: number/date/net/vat/total/status/document_type, `.company` m2o) ·
`moloni_avencas` (recorrências: name/amount/period/next_date/active, `.company` m2o) · `subscriptions`
(name/frequency/price_inc_vat/features/`client_ids` m2m/`moloni_service_id`) · `products` (Moloni: name/price/
tax_id/kind) · `companies` (is_client/name/nif/client_since/client_mrr/general_email/moloni_customer_id) ·
`lib/moloni-write.js` (emite documentos) · `lib/stripe.js` (stub) · `GET /api/moloni/documents/:id/pdf`.

## ⚠️ Decisões de negócio a CONFIRMAR (recomendação já proposta — ajusta no review)
1. **O que se vende + a quem:** os serviços do Moloni (manutenção, alojamento, projetos) a **prospetos**
   (converter lead→cliente) **e** upsell a clientes. → *recomendo: catálogo = `products` (Moloni) + pacotes em `subscriptions`.*
2. **One-time vs recorrente:** **ambos.** One-time (setup/projetos) = Stripe Checkout `mode=payment`. Recorrente
   (avenças) = **Stripe Billing** `mode=subscription` (cartão em ficheiro) **e** o Moloni emite a fatura/avença
   fiscal via webhook. → *recomendo isto; alternativa = manter a recorrência 100% no Moloni e Stripe só one-time.*
3. **Fonte da fatura:** **Moloni** (legal/SAF-T). Stripe = cobrança do cartão; webhook `paid` → `moloni-write` emite. ✅ fixo.

## 6a — Client Portal (read-only, SEM pagamentos) — construir 1.º
Página token-gated (padrão `/r/`,`/book/`) onde o cliente vê a sua conta. Zero escrita, zero cartão.
- **Schema:** `companies.portal_token` (aleatório, `crypto.randomBytes(24).hex`) + `companies.portal_enabled` (bool).
- **Rotas:** `GET /portal/:token` (HTML self-contained, estilo `bookHtml`: resumo do cliente + subscrições +
  avenças + faturas c/ estado) · `GET /api/portal/:token` (JSON) · `GET /api/portal/:token/document/:id/pdf`
  (**wrapper token-scoped** — valida `moloni_documents.company == empresa-do-token` ANTES de servir).
- **Isolamento:** TODAS as queries filtram `company = <id do token>`. `portal_enabled=false`/não-cliente → 404.
- **Excluir `/portal/*` + `/api/portal/*` do Authentik** (NPMplus) — como `/r/*`,`/t/*`.

### Entrega do link — TODAS as 3 (pedido do gpedro)
1. **Manual (staff):** botão "gerar/copiar link do portal" no drawer do cliente → `POST /api/portal/:companyId/link`
   (gera/roda o token, devolve o URL). O staff envia à mão.
2. **Auto-email no onboarding:** ao marcar `is_client=true` (`POST /api/clients/:companyId`) → gera o token +
   envia email de boas-vindas com o link (via `lib/mailer.js`). Idempotente (não re-envia se já tem token+enabled).
3. **No rodapé das faturas:** ao emitir um documento no Moloni (`lib/moloni-write.js`), incluir o URL do portal
   no campo de observações/notas do documento → aparece na fatura. (Fallback: incluir no email de envio da fatura.)

## 6b — Store / Checkout (Stripe **hosted**) — depois de 6a + decisões 1/2
- **`lib/stripe.js`:** `createCheckoutSession({ lineItems|priceId, mode, successUrl, cancelUrl, clientReferenceId,
  customerEmail })` + `verifyWebhook(rawBody, sig)` (assinatura obrigatória, `STRIPE_WEBHOOK_SECRET`). Hosted →
  PCI fica na Stripe.
- **`POST /api/checkout`** (staff, atrás do Authentik): gera o link de checkout p/ um `product`/`subscription` +
  um cliente/prospeto (`client_reference_id = companyId`). Devolve o URL.
- **`POST /api/stripe/webhook`** (público, **excluir do Authentik**, verificar assinatura): em
  `checkout.session.completed` / `invoice.paid` → (a) `moloni-write` emite a fatura/recibo (liga por
  `moloni_customer_id`), (b) marca `is_client=true` + atualiza `client_mrr`/`subscriptions`, (c) gera/ativa o
  portal_token + email (reusa 6a-2). Idempotente por `event.id` (guardar processados).
- **Schema:** `subscriptions.stripe_price_id` + `products.stripe_price_id` (link ao preço Stripe); `companies.stripe_customer_id`.
- **Teste:** só `STRIPE_TEST_SECRET_KEY` + cartões de teste + webhook via Stripe CLI. Nunca live sem validação do gpedro.

## 6c — Sell / conversão — depois de 6b
- Botão "Vender" no drawer do site/empresa (directório) → escolhe produto/subscrição → cria o checkout (6b)
  pré-preenchido; ao pagar (webhook) → conversão automática (cliente + avença/fatura Moloni + portal).
- Página pública opcional `GET /buy/:token` (checkout self-service a partir de um link de outreach) — token do
  email, como `/book/`. (Opcional; decidir se o self-service é desejado ou se o checkout é sempre iniciado pelo staff.)

## Segurança (é público + dinheiro)
- Portal: token longo aleatório, rotável; read-only; isolamento por `company`; PDF valida o dono; nunca expor o
  endpoint staff do PDF. Checkout: **hosted** (sem cartão no servidor); webhook **com assinatura**; **test mode**
  até validação; idempotência por `event.id`. Fatura fiscal = **Moloni**, não a Stripe.

## Ficheiros
`bootstrap-directus.js` (portal_token/enabled, stripe_* nas 3 coleções, stripe_customer_id, webhook-events dedup) ·
`dashboard/server.mjs` (rotas portal + checkout + webhook + geração de token/link + auto-email) · `lib/stripe.js`
(checkout+webhook) · `lib/moloni-write.js` (reusar p/ a fatura) · `lib/mailer.js` (email do portal) ·
`docs/reference/http-api.md` + `TODO-KEYS.md` (excluir `/portal/*`, `/api/portal/*`, `/api/stripe/webhook` do
Authentik; + `STRIPE_*` keys) · `index.html` (botões "Portal"/"Vender" nos drawers).

## Sequência de construção
6a portal (seguro, entrega já) → link nas 3 vias → 6b checkout+webhook (test mode) → 6c sell. Commitar cada
fatia com `git commit -- <paths>` (repo multi-sessão — ver [[multi-session-verify-plan]]).

## Verificação
- 6a: gerar token dum cliente real → `/portal/:token` mostra subscrições/avenças/faturas; token errado→404;
  PDF de outro cliente→403; as 3 vias de entrega do link funcionam.
- 6b: em test mode, checkout dum produto → cartão de teste → webhook → fatura criada no Moloni + portal ativado;
  assinatura de webhook inválida → rejeitada; re-entrega do mesmo `event.id` → idempotente (não duplica).
- 6c: botão "Vender" → checkout → pago → cliente convertido + avença/portal.
