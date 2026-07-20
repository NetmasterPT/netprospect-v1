# Plano (TODO) — Fase 6: Store / Stripe / Client Portal

> Pick-up-later. Feature GREENFIELD + SENSÍVEL (pagamentos). **Precisa de decisões de negócio antes de
> construir** — construir código de pagamento sobre pressupostos errados é pior que não construir.
> Ver [[netprospect-integrations]] (Moloni/Stripe/… já fundados), [[dashboard-posthog-gmb-state]].
> ⚠️ Regra de segurança: o Claude CONSTRÓI o código; **nunca executa pagamentos reais** nem manipula dados de
> cartão (usar sempre Stripe Checkout **hosted** → PCI fica na Stripe; o servidor nunca vê o cartão).

## O que existe hoje (auditado)

- `lib/stripe.js` — só stub: `stripeEnabled()`, `getStripeClient()`. **Sem** checkout/webhook/subscrição.
- `products` (Directus) — sincronizado do Moloni: `moloni_id, name, reference, price, tax_id, kind` (produto/serviço).
- `subscriptions` — híbrido (catálogo de outreach + billing-ish): `name, frequency, category, price_ex_vat,
  price_inc_vat, features, moloni_service_id, client_ids, icp_ids, campaign_ids, …`.
- `moloni_documents` + `moloni_avencas` (tabelas) — faturas + avenças sincronizadas do Moloni.
- 67 empresas `is_client` (todas com `nif`; `client_mrr` ainda a 0).
- Config flag `stripe.enabled` no dashboard (`STRIPE_TEST_SECRET_KEY`/`STRIPE_LIVE_SECRET_KEY`). Sem endpoints.

## Decisões NECESSÁRIAS (só o gpedro) — bloqueiam a construção

1. **O que se vende?** Os produtos vêm do Moloni (serviços: manutenção, alojamento…). O store vende a
   **prospetos** (converter lead→cliente) ou só a **clientes** existentes (upsell)? Que produtos/preços?
2. **Modelo de cobrança:** one-time (Stripe Checkout) vs **recorrente**. As avenças recorrentes ficam no
   **Moloni** (já existem `moloni_avencas`) e a Stripe só cobra one-time? OU Stripe Billing gere a recorrência
   e o Moloni só emite a fatura? (recomendação abaixo).
3. **Fonte de verdade da fatura:** a fatura legal é do **Moloni** (SAF-T PT). ⇒ Stripe = cobrança; Moloni =
   documento fiscal. O webhook Stripe (pago) → gerar a fatura no Moloni (`lib/moloni-write.js` já escreve).
4. **Auth do Client Portal:** token estável por cliente (padrão `/r/`,`/book/` — simples, sem password) vs
   magic-link por email vs Authentik-para-clientes. Recomendação: **token por cliente** (`companies.portal_token`).

## Arquitetura recomendada (sequência: seguro → sensível)

### 6a. Client Portal (READ-ONLY) — construível já, sem pagamentos, BAIXO risco
Página pública token-gated (reutiliza o padrão `/r/:token`,`/book/:token` + `bookHtml`): o cliente vê as suas
**subscrições/avenças** (via `subscriptions.client_ids` + `moloni_avencas`) e **faturas** (`moloni_documents`
pelo `nif` da empresa), com estado e PDF (o `/api/moloni/documents/:id/pdf` já existe). Sem escrita, sem cartão.
- Schema: `companies.portal_token` (str, gerado 1×) — o único acréscimo.
- Rotas: `GET /book/…`-style `GET /portal/:token` (excluir do Authentik como `/r/*`) + `GET /api/portal/:token`
  (dados). Reusar `_bLookup`/`bookHtml`-style. **É o slice a fazer PRIMEIRO** (valor + zero sensibilidade).

### 6b. Checkout (Stripe hosted) — precisa da decisão #1/#2 + Stripe test env
- `lib/stripe.js`: `createCheckoutSession({ items, mode:'payment'|'subscription', successUrl, cancelUrl,
  clientReferenceId })` (Stripe Checkout hosted). Nunca tocar no cartão.
- `POST /api/checkout` (dashboard, staff) → gera o link de checkout p/ um produto/subscrição + um cliente/prospeto.
- `POST /api/stripe/webhook` (público, **verificar assinatura** com `STRIPE_WEBHOOK_SECRET`; excluir do Authentik)
  → em `checkout.session.completed`/`invoice.paid`: marcar pago + **gerar a fatura no Moloni**
  (`lib/moloni-write.js createDocument`) + atualizar `subscriptions`/`companies.client_mrr`.
- **Sequência de teste:** só em Stripe **test mode** (`STRIPE_TEST_SECRET_KEY`), cartões de teste, webhook via
  Stripe CLI/endpoint. Nunca live sem o gpedro validar.

### 6c. Sell / conversão — depois de 6b
Botão no drawer do site/empresa: "vender X" → cria o checkout (6b) pré-preenchido; ao pagar (webhook) → marca
`is_client=true` + cria a avença/fatura no Moloni + liga a subscrição.

## Ficheiros a criar/tocar
`lib/stripe.js` (checkout/webhook helpers) · `dashboard/server.mjs` (`/portal/:token`, `/api/portal/:token`,
`/api/checkout`, `/api/stripe/webhook`) · `bootstrap-directus.js` (`companies.portal_token`, talvez
`subscriptions.stripe_*`) · `lib/moloni-write.js` (reusar p/ a fatura) · `docs/reference/http-api.md` +
TODO-KEYS (excluir `/portal/*` e `/api/stripe/webhook` do Authentik).

## Riscos / notas
- **Sensível (dinheiro):** Checkout **hosted** (PCI na Stripe); webhook com verificação de assinatura
  obrigatória; test mode até validação. O Claude não executa pagamentos reais.
- **Fatura fiscal = Moloni** (não a Stripe) — a Stripe cobra, o Moloni emite (SAF-T PT).
- **Sessão longa + repo multi-sessão:** construir com `git commit -- <paths>` (ver [[multi-session-verify-plan]]).
- **Começar por 6a** (portal read-only) — entrega valor sem tocar em pagamentos; 6b/6c só depois das decisões.
