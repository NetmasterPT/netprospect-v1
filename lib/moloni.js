// lib/moloni.js — cliente HTTP low-level do Moloni (API clássica v1).
// Port do netmaster-app (api/src/services/invoicing/moloni-client.ts), SEM Feathers/Directus.
//
// As 3 manhas do Moloni:
//   1. o body dos POST é `application/x-www-form-urlencoded` (JSON → "No company_id received")
//   2. o `access_token` vai na QUERY STRING, não no header Authorization
//   3. arrays aninhados usam notação PHP-bracket: products[0][taxes][0][tax_id]=…
//
// Auth: OAuth2 password-grant contra `${API_BASE}/grant/`. Token em cache no processo,
// refrescado 5 min antes de expirar. Se o refresh falhar (janela de 14 dias expirou),
// cai no password-grant — self-healing, sem re-auth manual.
//
// Sandbox vs live: env `MOLONI_MODE`.
//   MOLONI_MODE=live     → creds MOLONI_*,        documentos fechados (status=1)
//   qualquer outro valor → creds SANDBOX_MOLONI_*, rascunhos (status=0) — default seguro
// Lido uma vez por processo; mudar de modo exige `docker compose up -d --force-recreate`.
//
// Fail-soft (estilo do repo, cf. lib/ollama.js): `moloniEnabled()` (sync) diz se há creds;
// `getConfig()` lança com detalhe se faltar algo; `moloniCall()` lança em erro HTTP ou nos
// 4 formatos de erro do Moloni.

import { loadEnv } from './env.js';
loadEnv();

// ── Config (lê env; MOLONI_MODE escolhe o prefixo) ─────────────────────
function readMode() {
  const mode = (process.env.MOLONI_MODE || '').toLowerCase();
  return mode !== 'live'; // default = sandbox (rascunhos; mais seguro p/ instalações novas)
}

function envPrefix() {
  return readMode() ? 'SANDBOX_MOLONI_' : 'MOLONI_';
}

// True quando existem, pelo menos, as creds do password-grant + company_id (sem lançar).
export function moloniEnabled() {
  const e = process.env;
  const p = envPrefix();
  return !!(e[`${p}CLIENT_ID`] && e[`${p}CLIENT_SECRET`] && e[`${p}USERNAME`] && e[`${p}PASSWORD`] && e[`${p}COMPANY_ID`]);
}

// Lê a config do ambiente. Puro (sem I/O). Lança se faltar o essencial.
export function getConfig() {
  const isSandbox = readMode();
  const prefix = isSandbox ? 'SANDBOX_MOLONI_' : 'MOLONI_';
  const e = process.env;
  const cfg = {
    isSandbox,
    apiBase: e[`${prefix}API_BASE`] || 'https://api.moloni.pt/v1',
    clientId: e[`${prefix}CLIENT_ID`] || '',
    clientSecret: e[`${prefix}CLIENT_SECRET`] || '',
    username: e[`${prefix}USERNAME`] || '',
    password: e[`${prefix}PASSWORD`] || '',
    companyId: parseInt(e[`${prefix}COMPANY_ID`] || '0', 10),
    documentSetId: parseInt(e[`${prefix}DOCUMENT_SET_ID`] || '0', 10),
    ivaTaxId: parseInt(e[`${prefix}PT_IVA_TAX_ID`] || '0', 10),
    ivaIntracomTaxId: parseInt(e[`${prefix}PT_IVA_INTRACOM_TAX_ID`] || '0', 10),
    // Força status=1 (fechado) mesmo em sandbox — útil numa empresa Demo (sem
    // comunicação à AT) para renderizar/descarregar o PDF (rascunhos não têm PDF).
    finalizeDocuments: (e.MOLONI_FINALIZE_DOCUMENTS || '').toLowerCase() === 'true',
  };
  if (!cfg.clientId || !cfg.clientSecret || !cfg.username || !cfg.password) {
    throw new Error(`Moloni não configurado: faltam ${prefix}CLIENT_ID / CLIENT_SECRET / USERNAME / PASSWORD.`);
  }
  if (!cfg.companyId) {
    throw new Error(`Moloni: ${prefix}COMPANY_ID é obrigatório e numérico.`);
  }
  return cfg;
}

// Alias familiar (equivalente ao isXConfigured do netmaster-app).
export function isMoloniConfigured() {
  try { getConfig(); return true; } catch { return false; }
}

// ── Cache de token (por modo — sandbox e live independentes) ───────────
const tokenCache = new Map(); // chave = 'sandbox' | 'live'

async function obtainToken(cfg) {
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    username: cfg.username,
    password: cfg.password,
  });
  const res = await fetch(`${cfg.apiBase}/grant/?${params.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Moloni auth falhou: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 300) * 1000, // margem de segurança de 5 min
  };
}

async function refreshToken(cfg, current) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: current.refreshToken,
  });
  const res = await fetch(`${cfg.apiBase}/grant/?${params.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // Refresh falhou (ex.: janela de 14 dias expirou) → password-grant. Self-healing.
    console.warn('[Moloni] refresh falhou, a cair no password-grant:', JSON.stringify(json).slice(0, 200));
    return obtainToken(cfg);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in - 300) * 1000,
  };
}

async function getAccessToken(cfg) {
  const key = cfg.isSandbox ? 'sandbox' : 'live';
  let t = tokenCache.get(key);
  if (!t) {
    t = await obtainToken(cfg);
    tokenCache.set(key, t);
  } else if (Date.now() >= t.expiresAt) {
    t = await refreshToken(cfg, t);
    tokenCache.set(key, t);
  }
  return t.accessToken;
}

// ── Body form-urlencoded (achata objetos/arrays em chaves PHP-bracket) ──
//   { products: [{ name:'X', taxes:[{ tax_id:1 }] }] }
//   → products[0][name]=X&products[0][taxes][0][tax_id]=1
function flatten(obj, prefix = '') {
  const out = {};
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => Object.assign(out, flatten(v, prefix ? `${prefix}[${i}]` : String(i))));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== null && typeof v === 'object') Object.assign(out, flatten(v, key));
      else if (v !== undefined && v !== null) out[key] = String(v);
    }
    return out;
  }
  if (prefix) out[prefix] = String(obj);
  return out;
}

function toFormBody(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(flatten(obj))) params.append(k, v);
  return params.toString();
}

// ── moloniCall(path, body, opts) ───────────────────────────────────────
// Uso: await moloniCall('/customers/getByVat/', { vat: '999999990' })
// Injeta `company_id` automaticamente (exceto opts.skipCompanyId, p/ /companies/getAll).
// `access_token` vai na query. Lança em erro HTTP ou nos 4 formatos de erro do Moloni.
export async function moloniCall(path, body = {}, opts = {}) {
  const cfg = getConfig();
  const token = await getAccessToken(cfg);
  const fullBody = opts.skipCompanyId ? body : { company_id: cfg.companyId, ...body };
  const url = `${cfg.apiBase}${path}?access_token=${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toFormBody(fullBody),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`Moloni ${path}: resposta não-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  // O Moloni sinaliza erros em 4 formatos:
  //   { error, error_description }            erros OAuth
  //   { valid: 0, error_msg }                 falha da docs-API
  //   ["1 products", "5 customer_id"]         validação inline ("<código> <campo>")
  //   [["10 associated_id"], "5 related_id"]  validação aninhada (alguns inserts)
  // Códigos: 1=falta/obrigatório, 2=fora de range, 4=duplicado, 5=não está na lista válida.
  if (Array.isArray(parsed) && parsed.length > 0) {
    const flat = [];
    const walk = (v) => { if (typeof v === 'string') flat.push(v); else if (Array.isArray(v)) v.forEach(walk); };
    walk(parsed);
    if (flat.length > 0) {
      throw new Error(`Moloni ${path}: validação falhou — ${flat.join('; ').slice(0, 300)}`);
    }
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.error) {
      throw new Error(`Moloni ${path}: ${parsed.error} — ${parsed.error_description || ''}`);
    }
    if (parsed.valid === 0) {
      throw new Error(`Moloni ${path}: validação falhou — ${parsed.error_msg || JSON.stringify(parsed).slice(0, 200)}`);
    }
  }
  return parsed;
}

// Descarrega o PDF de um documento FECHADO (status=1). Port de moloni.ts:
// getPDFLink → landing HTML → segue o meta-refresh → bytes; valida a magic %PDF.
// (Rascunhos não têm PDF renderizado.)
export async function fetchPdfBuffer(documentId) {
  const link = await moloniCall('/documents/getPDFLink/', { document_id: documentId });
  if (!link || !link.url) throw new Error(`Moloni: getPDFLink sem URL para o documento ${documentId} (está fechado?)`);
  const landing = await fetch(link.url);
  if (!landing.ok) throw new Error(`Moloni PDF landing falhou: ${landing.status}`);
  const ct = landing.headers.get('content-type') || '';
  if (ct.includes('application/pdf')) return Buffer.from(await landing.arrayBuffer()); // tenants antigos
  const html = await landing.text();
  const m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*URL=([^"']+)["']/i);
  if (!m) throw new Error(`Moloni PDF landing sem meta-refresh (documento ${documentId})`);
  const directUrl = new URL(m[1].replace(/&amp;/g, '&'), link.url).toString();
  const pdf = await fetch(directUrl);
  if (!pdf.ok) throw new Error(`Moloni PDF download falhou: ${pdf.status}`);
  const arr = await pdf.arrayBuffer();
  const sig = Buffer.from(arr.slice(0, 4)).toString('utf8');
  if (sig !== '%PDF') throw new Error(`Moloni: resposta não-PDF (bytes ${JSON.stringify(sig)}) para o documento ${documentId}`);
  return Buffer.from(arr);
}

// Test-only: limpa a cache de tokens.
export function _clearCaches() { tokenCache.clear(); }
