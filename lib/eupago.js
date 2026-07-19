// lib/eupago.js — núcleo do cliente EuPago (Multibanco/MBWay/Payshop, PT). Port do
// netmaster, toggle via env (EUPAGO_MODE=live → clientes.eupago.pt, senão sandbox).
// API legacy v1: `chave` no body; sucesso=false → erro. Fail-soft: eupagoEnabled().
import { loadEnv } from './env.js';
loadEnv();

const DEFAULT_SANDBOX_BASE = 'https://sandbox.eupago.pt';
const DEFAULT_LIVE_BASE = 'https://clientes.eupago.pt';
const normalise = (raw) => raw.replace(/\/+$/, '').replace(/\/api$/, '');
function readMode() { return (process.env.EUPAGO_MODE || '').toLowerCase() !== 'live'; }

export function getEuPagoConfig() {
  const isSandbox = readMode();
  const apiKey = process.env.EUPAGO_API_KEY || '';
  if (!apiKey) throw new Error('EuPago não configurado: falta EUPAGO_API_KEY.');
  const rawBase = isSandbox ? (process.env.EUPAGO_SANDBOX_API_BASE_URL || DEFAULT_SANDBOX_BASE) : (process.env.EUPAGO_LIVE_API_BASE_URL || DEFAULT_LIVE_BASE);
  return { isSandbox, apiBase: normalise(rawBase), apiKey };
}
export function eupagoEnabled() { try { getEuPagoConfig(); return true; } catch { return false; } }
export const isEuPagoConfigured = eupagoEnabled;

// Chamada legacy v1 (a chave vai no body). Ex.: eupagoCall('/clientes/rest_api/multibanco/create', { valor, id })
export async function eupagoCall(path, body = {}) {
  const cfg = getEuPagoConfig();
  const res = await fetch(`${cfg.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chave: cfg.apiKey, ...body }) });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`EuPago ${path}: não-JSON (${res.status}): ${text.slice(0, 150)}`); }
  if (!res.ok) throw new Error(`EuPago ${path}: HTTP ${res.status}`);
  if (parsed && parsed.sucesso === false) throw new Error(`EuPago ${path}: ${parsed.resposta || 'erro'}`);
  return parsed;
}
