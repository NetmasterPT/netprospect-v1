# Plano — Fase 6: Client Portal + Loja multi-método + /buy + Sell

> Plano completo e COORDENADO. ⚠️ **Outra sessão já construiu a base da loja** (commit `e3bd611`): `lib/store.js`
> (Stripe checkout) + `/loja` + `/api/store/checkout` + `/api/stripe/webhook` (fulfillment: cria/mark cliente +
> liga subscrição + notifica; **fatura Moloni = TODO** por trás de `STORE_MOLONI_INVOICE`). **NÃO reescrever** —
> ESTENDER. Coordenar via `git commit -- <paths>` + grep antes de tocar em `lib/store.js`/`/loja`/webhook.
> Stripe **hosted** (cartão nunca no servidor); **fatura fiscal SEMPRE no Moloni**; pagamentos só em TEST até validação.
> Ver [[phase6-store-stripe-portal-plan]], [[netprospect-integrations]], [[multi-session-verify-plan]].

## Já existe (não refazer)
- `lib/store.js`: `createCheckoutSession(sub,{baseUrl,email})` + `verifyWebhookEvent` (Stripe).
- `/loja` (cards das `subscriptions` ativas → Stripe), `/loja/sucesso`, `/api/store/checkout`, `/api/stripe/webhook`.
- Clients de pagamento (baixo nível, integrações F): `lib/{stripe,eupago,paypal,coingate,wise}.js` (getConfig/enabled/call).
- Webhook faz: empresa por domínio do email → `is_client` + liga `subscriptions.client_ids` + email à equipa. PostHog `store_purchase`.

## Decisões (confirmadas pelo gpedro)
1. Vende os serviços Moloni a **prospetos + clientes**. ✅
2. **One-time (Checkout `mode=payment`, TODOS os métodos Stripe) + recorrente (Stripe Billing)**; **o Moloni fatura SEMPRE**. ✅
3. **Moloni = todas as faturas, sempre.** ✅

## Delta a construir (o que falta)

### A. Multi-MÉTODO de pagamento (não só Stripe) — estende `lib/store.js`
Métodos: **Stripe (todos os métodos: cartão, etc.)** · **EuPago MB (Multibanco) + MBWay** · **PayPal** · **CoinGate
(cripto)** · **Transferência bancária (manual)**. Wise = **desligado** (token expirado — deixar `enabled()=false`).
- Abstração `createPayment({ method, sub|items, email, companyId, ctx })` em `lib/store.js` que despacha para o
  client certo (`lib/{stripe,eupago,paypal,coingate}.js`) e devolve `{ url|reference, provider, mode }`:
  - **Stripe:** `mode=payment` (todos os métodos via `automatic_payment_methods`) OU `mode=subscription` (recorrente).
  - **EuPago:** MB → devolve **referência + entidade + valor**; MBWay → push para o telemóvel (nº). (`eupagoCall`).
  - **PayPal:** cria a order → `approve` URL (`paypalCall`).
  - **CoinGate:** cria a order → `payment_url` (`coingateCall`).
  - **Transferência:** mostra IBAN/refª + marca `pending` (confirmação MANUAL no dashboard → dispara fulfillment).
- **Confirmação por método** (cada um tem o seu): Stripe webhook (existe) · **EuPago webhook/callback** · **PayPal
  webhook** · **CoinGate callback** · transferência = botão staff "marcar paga". TODOS → a MESMA `fulfill(order)`.
- **`fulfill(order)` unificado** (refactor do que o webhook Stripe já faz): empresa→cliente + subscrição + Moloni
  + portal + notify + PostHog. Idempotente por `provider_event_id` (nova coleção `payments` p/ dedup + histórico).

### B. Fatura no Moloni (fechar o TODO) — em TODOS os métodos
No `fulfill()`: `lib/moloni-write.js createDocument` emite o **fatura-recibo** (liga por `companies.moloni_customer_id`;
cria o customer se não existir). ⚠️ **Bloqueado** hoje pelas permissões do app Moloni sandbox ([[netprospect-integrations]])
→ atrás de `STORE_MOLONI_INVOICE=1`; a lógica fica pronta, ativa-se quando a company Demo/permissões estiverem OK.

### C. `/buy/:token` — MUST-HAVE (conversão de outreach + analytics UTM server-side)
Página pública de compra por-link (token = o destinatário do outreach, como `/book/`), com **PostHog server-side
em CADA passo, gravando os UTMs + o contexto do token**:
- `GET /buy/:token?utm_source=…&utm_medium=…&utm_campaign=…&utm_content=…&utm_term=…` → resolve o email/token →
  contexto (campaign_id, angle, segment, ICP/público-alvo, interest, site/empresa) → renderiza a loja (cards +
  seletor de método). **Captura `$pageview` server-side** com `{utm_*, campaign_id, angle, segment, target_public,
  interest, domain, token}` (distinctId estável pelo token) → dá para cruzar **campanha × segmento × interesse ×
  público × método × conversão**.
- Eventos: `buy_viewed` → `buy_method_selected` → `buy_payment_started` → `store_purchase` (no fulfill), todos com
  os mesmos UTMs/contexto → funil completo atribuível por campanha.
- Reusa `storeShell` + `/api/store/checkout` (passando `token`+utm no metadata do pagamento → seguem até ao fulfill).

### D. Client Portal (read-only) — 6a, SEGURO, sem colisão com a loja
Token-gated `/portal/:token` (empresa por `companies.portal_token`), mostra **subscrições + avenças
(`moloni_avencas`) + faturas (`moloni_documents`)** filtradas por `company`, com PDF **token-scoped** (valida o
dono). `portal_enabled` liga/desliga. Excluir `/portal/*` do Authentik. — **é o slice mais seguro; posso começar por aqui.**
- **Entrega do link (as 3):** (1) botão "gerar/copiar link" no drawer do cliente; (2) auto-email ao marcar
  `is_client` (no `fulfill()` + no `POST /api/clients/:id`); (3) URL do portal nas **observações da fatura Moloni**
  (`moloni-write`) e/ou no email da fatura.

### E. Sell (6c) — dashboard
Botão "Vender" no drawer do site/empresa → escolhe pacote → gera um **`/buy/:token`** (com UTMs de origem "sell")
pré-preenchido → envia ao prospeto. Ao pagar → `fulfill()` converte tudo.

## Schema (bootstrap-directus.js)
`companies.{portal_token, portal_enabled, stripe_customer_id}` · `subscriptions.stripe_price_id` +
`products.stripe_price_id` · **coleção `payments`** (provider, provider_ref, method, status, amount, company,
subscription, token, utm json, event_id — dedup + histórico + fonte do fulfill idempotente).

## Ficheiros
`lib/store.js` (multi-método + `fulfill` + Moloni) · `lib/{eupago,paypal,coingate}.js` (reusar) · `dashboard/server.mjs`
(`/buy/:token`, `/portal/:token` + api, webhooks EuPago/PayPal/CoinGate, "marcar paga", geração de token/link, sell) ·
`lib/moloni-write.js` (fatura) · `lib/mailer.js` (emails) · `bootstrap-directus.js` (schema) · `docs/reference/http-api.md`
+ `TODO-KEYS.md` (excluir `/portal/*`,`/buy/*`,`/api/*/webhook` do Authentik; chaves EUPAGO/PAYPAL/COINGATE/STRIPE).

## Segurança (público + dinheiro)
Portal: token longo aleatório, read-only, isolamento por `company`, PDF valida dono. Pagamentos: hosted/redirect
(sem cartão no servidor); **cada webhook verifica assinatura**; idempotência por `payments.event_id`; **TEST mode**
até validação; **fatura = Moloni**. O Claude constrói; **nunca executa pagamentos reais**.

## Sequência + coordenação
1) **6a Portal** (seguro, aditivo, sem tocar na loja) — bom para começar já. 2) **`payments` + `fulfill()` unificado
+ Moloni** (refactor do webhook — **coordenar** com a sessão da loja). 3) **Multi-método** (EuPago/PayPal/CoinGate/
transferência + webhooks). 4) **`/buy/:token` + UTM analytics**. 5) **Sell**. Commitar cada fatia com `git commit -- <paths>`.

## Verificação
- 6a: token dum cliente → portal mostra dados; token errado→404; PDF de outro→403.
- Pagamentos (TEST): cada método → confirmação → `fulfill` (cliente+subscrição+Moloni-flag+portal) 1× (idempotente).
- `/buy/:token`: PostHog regista `$pageview`+funil com UTMs+contexto; distinctId estável; atribuição por campanha OK.
