// lib/wise.js — núcleo do cliente Wise (transferências). Port do netmaster, toggle via
// env (WISE_MODE=live → api.wise.com, senão sandbox). Bearer token. Fail-soft.
// Nota: iban/bic/accountHolder são detalhes de payout (não exigidos para as chamadas).
import { loadEnv } from './env.js';
loadEnv();

const SANDBOX_BASE = 'https://api.sandbox.transferwise.tech';
const LIVE_BASE = 'https://api.wise.com';
function readMode() { return (process.env.WISE_MODE || '').toLowerCase() !== 'live'; }

export function getWiseConfig() {
  const isSandbox = readMode();
  const e = process.env;
  const prefix = isSandbox ? 'WISE_SANDBOX_' : 'WISE_LIVE_';
  const cfg = {
    isSandbox,
    apiBase: isSandbox ? SANDBOX_BASE : LIVE_BASE,
    token: e[`${prefix}API_TOKEN`] || '',
    profileId: e[`${prefix}PROFILE_ID`] || '',
    balanceId: e[`${prefix}BALANCE_ID`] || '',
    iban: e[`${prefix}IBAN`] || '',
    bic: e[`${prefix}BIC`] || '',
    accountHolder: e[`${prefix}ACCOUNT_HOLDER`] || '',
  };
  if (!cfg.token || !cfg.profileId || !cfg.balanceId) throw new Error(`Wise não configurado: falta ${prefix}API_TOKEN / PROFILE_ID / BALANCE_ID.`);
  return cfg;
}
export function wiseEnabled() { try { getWiseConfig(); return true; } catch { return false; } }
export const isWiseConfigured = wiseEnabled;

export async function wiseCall(path, opts = {}) {
  const cfg = getWiseConfig();
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  if (!text) { if (!res.ok) throw new Error(`Wise ${path}: HTTP ${res.status} (vazio)`); return {}; }
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`Wise ${path}: não-JSON (${res.status})`); }
  if (!res.ok) throw new Error(`Wise ${path}: HTTP ${res.status} — ${JSON.stringify(parsed).slice(0, 200)}`);
  return parsed;
}
