// lib/whois.js — ROUTER de WHOIS (Part B), tiered por-TLD.
// Escolhe a via por TLD (evidência live 2026-07-11): .nl/.no/.fi → RDAP (grátis, JSON, sem
// expiry); .se → port-43 whoiser (dá registrar+created+EXPIRY); .pt → WhoisXML best-effort
// (sem RDAP; port-43 filtra IPs de datacenter). Cascata: um tier sem dados → o próximo.
// LANÇA em rate-limit (429/503) se TODOS os tiers rate-limitarem → o job faz nak+backoff.
// Todos os tiers devolvem a MESMA shape {registrar,created,expiry,ageDays,expiringSoon}.
import { whoisDomain, firstResult } from 'whoiser';
import { lookupRdap, tldOf } from './rdap.js';
import { lookupWhoisXml, whoisXmlEnabled } from './whois-providers.js';

const pick = (o, keys) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return Array.isArray(o[k]) ? o[k][0] : o[k];
  const lk = keys.map((k) => k.toLowerCase());
  for (const k of Object.keys(o)) if (lk.some((x) => k.toLowerCase().includes(x))) { const v = o[k]; return Array.isArray(v) ? v[0] : v; }
  return null;
};
function parseDate(s) { if (!s) return null; const d = new Date(String(s).trim()); return Number.isNaN(d.getTime()) ? null : d; }

// --- Tier PORT-43 (whoiser) — inalterado, agora um dos tiers do router ----------------
export async function lookupPort43(domain, { timeout = 10000 } = {}) {
  let r;
  try { r = await whoisDomain(domain, { follow: 1, timeout }); }
  catch { return null; }
  const d = (firstResult ? firstResult(r) : null) || r[Object.keys(r)[0]] || {};
  const registrar = pick(d, ['Registrar', 'registrar', 'Sponsoring Registrar']);
  const created = parseDate(pick(d, ['Created Date', 'Creation Date', 'created', 'registered', 'Registration Date', 'Domain Registration Date']));
  const expiry = parseDate(pick(d, ['Expiry Date', 'Expiration Date', 'Registry Expiry Date', 'expires', 'paid-till', 'Renewal Date', 'Domain Expiration Date']));
  const now = Date.now();
  const daysToExpiry = expiry ? (expiry.getTime() - now) / 86400000 : null;
  return {
    registrar: registrar ? String(registrar).slice(0, 255) : null,
    created: created ? created.toISOString() : null,
    expiry: expiry ? expiry.toISOString() : null,
    ageDays: created ? Math.round((now - created.getTime()) / 86400000) : null,
    expiringSoon: daysToExpiry != null && daysToExpiry > 0 && daysToExpiry <= 90,
  };
}

// --- ROUTER ---------------------------------------------------------------------------
const ROUTE = {
  no: ['rdap', 'port43', 'whoisxml'],
  nl: ['rdap', 'port43', 'whoisxml'],
  fi: ['rdap', 'port43', 'whoisxml'],
  se: ['port43', 'whoisxml'],       // sem RDAP; port-43 dá tudo incl. expiry
  pt: ['whoisxml', 'port43'],       // sem RDAP; port-43 filtra datacenter → WhoisXml best-effort
};
const DEFAULT_ROUTE = ['rdap', 'port43', 'whoisxml']; // TLD novo: RDAP via bootstrap IANA → fallback
const usable = (r) => !!(r && (r.registrar || r.created));

async function runTier(tier, domain, opts) {
  if (tier === 'rdap') return lookupRdap(domain, opts);
  if (tier === 'port43') return lookupPort43(domain, opts);
  if (tier === 'whoisxml') return whoisXmlEnabled() ? lookupWhoisXml(domain, opts) : null;
  return null;
}

export async function lookupWhois(domain, opts = {}) {
  const route = ROUTE[tldOf(domain)] || DEFAULT_ROUTE;
  let rateLimited = false; let best = null;
  for (const tier of route) {
    try {
      const r = await runTier(tier, domain, opts);
      if (usable(r)) return r;         // primeiro tier com dados úteis ganha
      if (r && !best) best = r;         // partial (não-null mas sem registrar/created)
    } catch (e) {
      if (e?.rateLimited) rateLimited = true; // 429/503 → tenta o próximo tier
    }
  }
  if (!best && rateLimited) { const e = new Error('whois: todos os tiers rate-limited (429)'); e.rateLimited = true; throw e; }
  return best; // null = sem dados em lado nenhum (ex.: .pt sem WhoisXml keys)
}
