// lib/openprovider.js — cliente da API OpenProvider (domínios). Port 1:1 do
// netmaster-app (self-contained, fetch nativo): auth com cache de token (~23h) +
// check de disponibilidade em lote (máx 15/req). Fail-soft: openproviderEnabled().
import { loadEnv } from './env.js';
loadEnv();

const DEFAULT_API_URL = 'https://api.openprovider.eu/v1beta';
let cachedToken = null;

function getConfig() {
  const username = process.env.OPENPROVIDER_USERNAME;
  const password = process.env.OPENPROVIDER_PASSWORD;
  const passwordHash = process.env.OPENPROVIDER_PASSWORD_HASH;
  if (!username || (!password && !passwordHash)) return null;
  return {
    username,
    password: password || undefined,
    passwordHash: passwordHash || undefined,
    apiUrl: (process.env.OPENPROVIDER_API_URL || DEFAULT_API_URL).replace(/\/$/, ''),
  };
}
export function openproviderEnabled() { return getConfig() !== null; }
export const isConfigured = openproviderEnabled;

async function opFetch(path, opts = {}) {
  const cfg = getConfig();
  if (!cfg) throw new Error('OpenProvider sem credenciais configuradas');
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenProvider ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { throw new Error(`OpenProvider ${path}: JSON inválido`); }
}

// Autentica e cacheia o token (reutiliza até 5 min antes de expirar; ~24h de vida).
export async function getToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60000) return cachedToken.token;
  const cfg = getConfig();
  if (!cfg) throw new Error('OpenProvider sem credenciais configuradas');
  const json = await opFetch('/auth/login', { method: 'POST', body: { username: cfg.username, password: cfg.password || cfg.passwordHash } });
  const token = json?.data?.token;
  if (!token) throw new Error('OpenProvider login: sem token na resposta');
  cachedToken = { token, expiresAt: now + 23 * 60 * 60000 };
  return token;
}

const CHECK_BATCH_SIZE = 15;
// Check de disponibilidade em lote (a API limita a 15/req → chunk + paralelo).
export async function checkDomains(domains) {
  if (!domains || domains.length === 0) return [];
  const token = await getToken();
  const batches = [];
  for (let i = 0; i < domains.length; i += CHECK_BATCH_SIZE) batches.push(domains.slice(i, i + CHECK_BATCH_SIZE));
  const responses = await Promise.all(batches.map(async (batch) => {
    const payload = { domains: batch.map((d) => { const parts = d.toLowerCase().split('.'); return { name: parts[0], extension: parts.slice(1).join('.') }; }), with_price: true };
    try { const json = await opFetch('/domains/check', { method: 'POST', body: payload, token }); return json?.data?.results || []; }
    catch (err) { console.warn(`[OpenProvider] batch falhou: ${(err.message || '').slice(0, 100)}`); return batch.map(() => ({ status: 'unknown' })); }
  }));
  const byDomain = new Map();
  for (const r of responses.flat()) if (r?.domain) byDomain.set(r.domain.toLowerCase(), r);
  return domains.map((domain) => {
    const lower = domain.toLowerCase();
    const r = byDomain.get(lower) || {};
    let status = 'unknown';
    if (r.status === 'free') status = 'free'; else if (r.status === 'active') status = 'active';
    const reseller = r.price?.reseller;
    const resellerPrice = typeof reseller?.price === 'number' ? reseller.price : (reseller?.price != null ? parseFloat(reseller.price) : undefined);
    return { domain: lower, status, reason: r.reason || undefined, resellerPrice, resellerCurrency: reseller?.currency };
  });
}

export function resetTokenCache() { cachedToken = null; }
