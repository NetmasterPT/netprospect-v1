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

// --- Multi-MÉTODO (Fase 6b-methods) — dispatcher por provider -------------------------------------
// createPayment({ method, sub, amount, email, phone, ref, baseUrl, cancelUrl, extraMeta }) → resultado
// NORMALIZADO: { provider, method, provider_ref, kind:'redirect'|'reference'|'push', url?, entity?,
// reference?, amount?, message? }. `ref` = referência LOCAL única (o server liga o webhook a este pagamento).
// ⚠️ EuPago/PayPal/CoinGate seguem as APIs documentadas + os clients existentes (lib/{eupago,paypal,coingate}.js)
// mas NÃO foram validados end-to-end (providers config-blocked/sem sandbox creds) → validar com creds reais.
export async function createPayment(o) {
  const price = Number(o.amount ?? o.sub?.price_inc_vat ?? o.sub?.price_ex_vat);
  if (!(price > 0)) throw new Error('sem preço válido');
  const val = price.toFixed(2);
  const name = String(o.sub?.name || 'Serviço Netmaster').slice(0, 120);
  switch (o.method) {
    case 'stripe': case undefined: case null: case '': {
      const s = await createCheckoutSession(o.sub, { baseUrl: o.baseUrl, email: o.email, extraMeta: o.extraMeta, cancelUrl: o.cancelUrl });
      return { provider: 'stripe', method: 'card', provider_ref: s.id, kind: 'redirect', url: s.url };
    }
    case 'eupago_mb': {
      const { eupagoCall } = await import('./eupago.js');
      const r = await eupagoCall('/clientes/rest_api/multibanco/create', { valor: val, id: o.ref, per_dup: 0 });
      return { provider: 'eupago', method: 'multibanco', provider_ref: String(r.referencia || o.ref), kind: 'reference', entity: r.entidade, reference: r.referencia, amount: r.valor || val, message: 'Paga por Multibanco com a entidade + referência.' };
    }
    case 'eupago_mbway': {
      if (!o.phone) throw new Error('MBWay precisa do nº de telemóvel');
      const { eupagoCall } = await import('./eupago.js');
      const r = await eupagoCall('/clientes/rest_api/mbway/create', { valor: val, id: o.ref, telemovel: String(o.phone).replace(/\D/g, '') });
      return { provider: 'eupago', method: 'mbway', provider_ref: String(r.referencia || o.ref), kind: 'push', amount: val, message: 'Confirma o pagamento na app MB WAY no teu telemóvel.' };
    }
    case 'paypal': {
      const { paypalCall } = await import('./paypal.js');
      const order = await paypalCall('/v2/checkout/orders', { json: { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'EUR', value: val }, custom_id: o.ref, description: name }], application_context: { brand_name: 'Netmaster', user_action: 'PAY_NOW', return_url: `${o.baseUrl}/loja/sucesso?provider=paypal&ref=${encodeURIComponent(o.ref)}`, cancel_url: o.cancelUrl || `${o.baseUrl}/loja?cancelado=1` } } });
      const approve = (order.links || []).find((l) => l.rel === 'approve')?.href;
      if (!approve) throw new Error('PayPal: sem link de aprovação');
      return { provider: 'paypal', method: 'paypal', provider_ref: String(order.id), kind: 'redirect', url: approve };
    }
    case 'coingate': {
      const { coingateCall } = await import('./coingate.js');
      const order = await coingateCall('/orders', { json: { order_id: o.ref, price_amount: val, price_currency: 'EUR', receive_currency: 'EUR', title: name, success_url: `${o.baseUrl}/loja/sucesso?provider=coingate&ref=${encodeURIComponent(o.ref)}`, cancel_url: o.cancelUrl || `${o.baseUrl}/loja?cancelado=1`, callback_url: `${o.baseUrl}/api/coingate/callback` } });
      if (!order.payment_url) throw new Error('CoinGate: sem payment_url');
      return { provider: 'coingate', method: 'crypto', provider_ref: String(order.id), kind: 'redirect', url: order.payment_url };
    }
    case 'bank': { // transferência manual — sem API; a equipa confirma o comprovativo
      return { provider: 'bank', method: 'transfer', provider_ref: o.ref, kind: 'reference', iban: process.env.STORE_IBAN || '', reference: o.ref, amount: val, message: 'Transfere e envia o comprovativo; a equipa confirma e ativa a tua conta.' };
    }
    default: throw new Error('método desconhecido: ' + o.method);
  }
}

// Quais métodos estão configurados (p/ o seletor da loja mostrar só os disponíveis).
export async function availableMethods() {
  const out = [];
  try { const { stripeEnabled } = await import('./stripe.js'); if (stripeEnabled()) out.push({ id: 'stripe', label: 'Cartão' }); } catch { /* off */ }
  try { const { eupagoEnabled } = await import('./eupago.js'); if (eupagoEnabled()) out.push({ id: 'eupago_mbway', label: 'MB WAY' }, { id: 'eupago_mb', label: 'Multibanco' }); } catch { /* off */ }
  try { const { paypalEnabled } = await import('./paypal.js'); if (paypalEnabled()) out.push({ id: 'paypal', label: 'PayPal' }); } catch { /* off */ }
  try { const { coingateEnabled } = await import('./coingate.js'); if (coingateEnabled()) out.push({ id: 'coingate', label: 'Cripto' }); } catch { /* off */ }
  if (process.env.STORE_IBAN) out.push({ id: 'bank', label: 'Transferência' });
  return out;
}
