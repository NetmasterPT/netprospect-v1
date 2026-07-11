// lib/whois-providers.js
// Tier WhoisXML do WHOIS (Part B) — best-effort p/ .pt (sem RDAP + port-43 filtrado por IP)
// e fallback p/ expiry onde RDAP/port-43 não dão. Multi-key round-robin (free = 1000/mês/key
// → várias contas), grátis. Config gitignored `config/whois-providers.json` ou env
// WHOISXML_API_KEYS (csv). INERTE sem keys (whoisXmlEnabled()=false → o router salta o tier).
import fs from 'node:fs';
import { getDomain } from 'tldts';

const UA = 'netprospect-whois/1.0 (+https://netmaster.pt)';
let KEYS = null; let idx = 0;

function loadKeys() {
  if (KEYS !== null) return KEYS;
  const env = (process.env.WHOISXML_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) { KEYS = env; return KEYS; }
  try {
    const c = JSON.parse(fs.readFileSync(process.env.WHOIS_PROVIDERS_CONFIG || 'config/whois-providers.json', 'utf8'));
    KEYS = (c.whoisxml?.apiKeys || []).filter(Boolean);
  } catch { KEYS = []; }
  return KEYS;
}
export function whoisXmlEnabled() { return loadKeys().length > 0; }

// Devolve a shape whois OU null. LANÇA em 429 (rate limit / quota) p/ nak+backoff.
export async function lookupWhoisXml(domain, { timeout = 12000 } = {}) {
  const keys = loadKeys(); if (!keys.length) return null;
  const key = keys[idx++ % keys.length]; // round-robin pelas contas
  const apex = getDomain(domain) || domain;
  const url = `https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=${encodeURIComponent(key)}&domainName=${encodeURIComponent(apex)}&outputFormat=JSON`;
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) }); }
  catch { return null; }
  if (r.status === 429) { const e = new Error('whoisxml 429'); e.rateLimited = true; e.status = 429; throw e; }
  if (!r.ok) return null;
  let j; try { j = await r.json(); } catch { return null; }
  const w = j?.WhoisRecord || {};
  const reg = w.registrarName || w.registryData?.registrarName || null;
  const created = w.createdDate || w.registryData?.createdDate || null;
  const expiry = w.expiresDate || w.registryData?.expiresDate || null;
  const cD = created ? new Date(created) : null; const eD = expiry ? new Date(expiry) : null;
  const now = Date.now();
  const dte = eD && !isNaN(eD) ? (eD.getTime() - now) / 86400000 : null;
  if (!reg && !(cD && !isNaN(cD))) return null;
  return {
    registrar: reg ? String(reg).slice(0, 255) : null,
    created: cD && !isNaN(cD) ? cD.toISOString() : null,
    expiry: eD && !isNaN(eD) ? eD.toISOString() : null,
    ageDays: cD && !isNaN(cD) ? Math.round((now - cD.getTime()) / 86400000) : null,
    expiringSoon: dte != null && dte > 0 && dte <= 90,
  };
}
