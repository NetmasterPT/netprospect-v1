// lib/paypal.js — núcleo do cliente PayPal (Fase F, sem feature). Port do netmaster,
// toggle sandbox/live via env (PAYPAL_MODE=live → LIVE_*, senão SANDBOX_*). OAuth2
// client_credentials com cache de token. paypalCall(path, opts). Fail-soft.
import { loadEnv } from './env.js';
loadEnv();

function readMode() { return (process.env.PAYPAL_MODE || '').toLowerCase() !== 'live'; }
export function getPayPalConfig() {
  const isSandbox = readMode();
  const e = process.env;
  const cfg = {
    isSandbox,
    apiBase: isSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com',
    clientId: isSandbox ? (e.PAYPAL_SANDBOX_CLIENT_ID || '') : (e.PAYPAL_LIVE_CLIENT_ID || ''),
    clientSecret: isSandbox ? (e.PAYPAL_SANDBOX_CLIENT_SECRET || '') : (e.PAYPAL_LIVE_CLIENT_SECRET || ''),
    webhookId: isSandbox ? (e.PAYPAL_SANDBOX_WEBHOOK_ID || '') : (e.PAYPAL_LIVE_WEBHOOK_ID || ''),
  };
  if (!cfg.clientId || !cfg.clientSecret) throw new Error(`PayPal não configurado: falta ${isSandbox ? 'PAYPAL_SANDBOX_' : 'PAYPAL_LIVE_'}CLIENT_ID/SECRET.`);
  return cfg;
}
export function paypalEnabled() { try { getPayPalConfig(); return true; } catch { return false; } }
export const isPayPalConfigured = paypalEnabled;

const tokenCache = new Map();
async function getAccessToken(cfg) {
  const key = cfg.isSandbox ? 'sandbox' : 'live';
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(`${cfg.apiBase}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`PayPal auth falhou: ${JSON.stringify(json).slice(0, 200)}`);
  const tok = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
  tokenCache.set(key, tok);
  return tok.accessToken;
}

export async function paypalCall(path, opts = {}) {
  const cfg = getPayPalConfig();
  const token = await getAccessToken(cfg);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.idempotencyKey ? { 'PayPal-Request-Id': opts.idempotencyKey } : {}), ...opts.headers };
  const res = await fetch(`${cfg.apiBase}${path}`, { method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'), headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  const text = await res.text();
  if (!text) { if (!res.ok) throw new Error(`PayPal ${path}: HTTP ${res.status} (vazio)`); return {}; }
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`PayPal ${path}: não-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`PayPal ${path}: HTTP ${res.status} — ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed;
}
