// lib/stripe.js — núcleo do cliente Stripe (Fase F, sem feature). Port do netmaster,
// com o toggle sandbox/live via env (STRIPE_MODE=live → LIVE_*, senão TEST_*) em vez
// do Directus. getStripeClient() devolve a instância do SDK. Fail-soft: stripeEnabled().
import { loadEnv } from './env.js';
import Stripe from 'stripe';
loadEnv();

function getMode() {
  const isSandbox = (process.env.STRIPE_MODE || '').toLowerCase() !== 'live';
  return {
    isSandbox,
    secretKey: isSandbox ? (process.env.STRIPE_TEST_SECRET_KEY || '') : (process.env.STRIPE_LIVE_SECRET_KEY || ''),
    publishableKey: isSandbox ? (process.env.STRIPE_TEST_PUBLISHABLE_KEY || '') : (process.env.STRIPE_LIVE_PUBLISHABLE_KEY || ''),
  };
}
export function stripeEnabled() { return Boolean(getMode().secretKey); }
export const isStripeConfigured = stripeEnabled;

let cachedClient = null;
export function getStripeClient() {
  const { isSandbox, secretKey, publishableKey } = getMode();
  if (!secretKey) throw new Error(`Stripe não configurado: falta ${isSandbox ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY'}.`);
  if (!cachedClient || cachedClient.sandbox !== isSandbox) cachedClient = { sandbox: isSandbox, client: new Stripe(secretKey) };
  return { stripe: cachedClient.client, isSandbox, publishableKey };
}
