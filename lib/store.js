// lib/store.js — Loja pública (Fase 6). Cria sessões de Stripe Checkout para as subscrições e verifica
// os webhooks. A fulfillment (ativar subscrição, marcar cliente, notificar, faturar no Moloni) vive no
// dashboard (server.mjs) porque precisa do Directus/mailer. Tudo em modo TEST por defeito (STRIPE_MODE≠live).
import { getStripeClient, stripeWebhookSecret } from './stripe.js';

// Frequência da subscrição → recurring do Stripe. one_off = pagamento único (mode 'payment').
const INTERVAL = {
  monthly: { interval: 'month', interval_count: 1 },
  quarterly: { interval: 'month', interval_count: 3 },
  semiannual: { interval: 'month', interval_count: 6 },
  annual: { interval: 'year', interval_count: 1 },
};

// Cria uma Checkout Session para uma subscrição. Preço = price_inc_vat (o cliente paga c/ IVA); cêntimos.
// baseUrl = origem pública da loja (para os success/cancel). email opcional (pré-preenche o checkout).
export async function createCheckoutSession(sub, { baseUrl, email = null, extraMeta = {}, cancelUrl = null } = {}) {
  const { stripe, isSandbox } = getStripeClient();
  const price = Number(sub.price_inc_vat ?? sub.price_ex_vat);
  if (!(price > 0)) throw new Error('subscrição sem preço válido');
  const rec = INTERVAL[sub.frequency];
  const mode = rec ? 'subscription' : 'payment';
  const line_items = [{
    quantity: 1,
    price_data: {
      currency: 'eur',
      product_data: { name: sub.name, ...(sub.category ? { metadata: { category: sub.category } } : {}) },
      unit_amount: Math.round(price * 100),
      ...(rec ? { recurring: rec } : {}),
    },
  }];
  // extraMeta (do /buy/:token): company_id, buy_token, utm (JSON) → segue no metadata até ao fulfill (atribuição).
  // Stripe: valores string, ≤500 chars. Clip defensivo.
  const clean = {}; for (const [k, v] of Object.entries(extraMeta || {})) if (v != null && v !== '') clean[k] = String(v).slice(0, 480);
  const meta = { subscription_id: String(sub.id), subscription_name: String(sub.name || '').slice(0, 200), moloni_service_id: sub.moloni_service_id ? String(sub.moloni_service_id) : '', ...clean };
  const session = await stripe.checkout.sessions.create({
    mode,
    line_items,
    success_url: `${baseUrl}/loja/sucesso?sid={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${baseUrl}/loja?cancelado=1`,
    client_reference_id: String(sub.id),
    metadata: meta,
    billing_address_collection: 'auto',
    allow_promotion_codes: true,
    // Todos os métodos de pagamento configurados na conta Stripe (cartão + o que estiver ativo).
    automatic_payment_methods: undefined, // (checkout usa por defeito os métodos ativos na conta)
    ...(email ? { customer_email: email } : {}),
    ...(rec ? { subscription_data: { metadata: meta } } : {}),
  });
  return { id: session.id, url: session.url, mode, isSandbox };
}

// Verifica a assinatura do webhook e devolve o evento (lança se inválido/sem segredo — fail-closed).
export function verifyWebhookEvent(rawBody, signature) {
  const secret = stripeWebhookSecret();
  if (!secret) throw new Error('webhook não verificável: falta STRIPE_TEST/LIVE_WEBHOOK_SECRET');
  const { stripe } = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
