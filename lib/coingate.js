// lib/coingate.js — núcleo do cliente CoinGate (cripto). Port do netmaster, toggle
// via env (COINGATE_MODE=live → LIVE_*, senão SANDBOX_*). Bearer token. Fail-soft.
import { loadEnv } from './env.js';
loadEnv();

const SANDBOX_BASE = 'https://api-sandbox.coingate.com/v2';
const LIVE_BASE = 'https://api.coingate.com/v2';
function readMode() { return (process.env.COINGATE_MODE || '').toLowerCase() !== 'live'; }

export function getCoinGateConfig() {
  const isSandbox = readMode();
  const e = process.env;
  const cfg = {
    isSandbox,
    apiBase: isSandbox ? SANDBOX_BASE : LIVE_BASE,
    token: isSandbox ? (e.COINGATE_SANDBOX_API_TOKEN || '') : (e.COINGATE_LIVE_API_TOKEN || ''),
    callbackSecret: isSandbox ? (e.COINGATE_SANDBOX_CALLBACK_SECRET || '') : (e.COINGATE_LIVE_CALLBACK_SECRET || ''),
  };
  if (!cfg.token) throw new Error(`CoinGate não configurado: falta ${isSandbox ? 'COINGATE_SANDBOX_' : 'COINGATE_LIVE_'}API_TOKEN.`);
  return cfg;
}
export function coingateEnabled() { try { getCoinGateConfig(); return true; } catch { return false; } }
export const isCoinGateConfigured = coingateEnabled;

export async function coingateCall(path, opts = {}) {
  const cfg = getCoinGateConfig();
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method: opts.method || (opts.json !== undefined ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  if (!text) { if (!res.ok) throw new Error(`CoinGate ${path}: HTTP ${res.status} (vazio)`); return {}; }
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`CoinGate ${path}: não-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`CoinGate ${path}: HTTP ${res.status} — ${JSON.stringify(parsed).slice(0, 200)}`);
  return parsed;
}
