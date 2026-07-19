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
// ⚠️ O body TEM de ser form-urlencoded: o netmaster confirmou que a API 2.0 (JSON) rejeita todos os shapes
// (CUSTOMERPHONE_MISSING/AMOUNT_MISSING) e só o v1 form-urlencoded funciona nos 3 métodos. A resposta é JSON.
export async function eupagoCall(path, body = {}) {
  const cfg = getEuPagoConfig();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ chave: cfg.apiKey, ...body })) if (v != null) params.append(k, String(v));
  const res = await fetch(`${cfg.apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error(`EuPago ${path}: não-JSON (${res.status}): ${text.slice(0, 150)}`); }
  if (!res.ok) throw new Error(`EuPago ${path}: HTTP ${res.status}`);
  if (parsed && parsed.sucesso === false) throw new Error(`EuPago ${path}: ${parsed.resposta || `estado=${parsed.estado}` || 'erro'}`);
  return parsed;
}

// Smoke: a API v1 do EuPago só tem `create` (não há endpoint read-only). Em SANDBOX cria uma referência
// Multibanco mínima (inofensiva — gera uma referência a pagar, não cobra ninguém) e confirma entidade+
// referência (prova chave + endpoint + formato). Em LIVE NÃO cria (evita referências reais) — só valida a config.
export async function smokeEuPago() {
  const cfg = getEuPagoConfig(); // lança se não estiver configurado
  if (!cfg.isSandbox) return { ok: true, mode: 'live', note: 'config presente; create não executado em live (evita referências reais)' };
  const r = await eupagoCall('/clientes/rest_api/multibanco/create', { valor: '1.00', id: `smoke-${cfg.apiKey.slice(-6)}` });
  return { ok: !!(r?.referencia && r?.entidade), mode: 'sandbox', entidade: r?.entidade || null, referencia: r?.referencia || null, valor: r?.valor || null };
}
