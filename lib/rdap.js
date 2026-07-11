// lib/rdap.js
// Tier RDAP do WHOIS (Part B). RDAP (RFC 9083) = HTTP+JSON standardizado, grátis,
// distribuível por IP. Testado 2026-07-11: funciona p/ .no/.nl/.fi (registrar+created;
// SEM expiry — política dos registries); .pt/.se NÃO têm RDAP público (→ router cascata).
// Devolve a MESMA shape que lib/whois.js p/ o router poder cascatear sem os handlers mudarem.
import { getDomain } from 'tldts';
import { acquire, penalize } from './ratelimit.js';

const UA = process.env.RDAP_UA || 'Mozilla/5.0 (compatible; netprospect-rdap/1.0; +https://netmaster.pt)';
const TIMEOUT = parseInt(process.env.RDAP_TIMEOUT_MS || '12000', 10);
const RATE = parseInt(process.env.RDAP_RATE_PER_SEC || '2', 10); // por registry host, por IP

// Mapa hardcoded (fonte primária — o IANA bootstrap NÃO lista .se/.pt, e o mapa evita 1
// fetch ao bootstrap p/ os TLDs que já conhecemos). Bootstrap = suplemento p/ TLDs futuros.
const RDAP_BASE = {
  no: 'https://rdap.norid.no/',
  nl: 'https://rdap.sidn.nl/',
  fi: 'https://rdap.fi/rdap/rdap/',
};

let BOOTSTRAP = null; // cache em memória do IANA dns.json
async function bootstrapBase(tld) {
  if (RDAP_BASE[tld]) return RDAP_BASE[tld];
  if (!BOOTSTRAP) {
    BOOTSTRAP = {};
    try {
      const r = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(TIMEOUT) });
      const j = await r.json();
      for (const svc of j.services || []) for (const t of svc[0] || []) BOOTSTRAP[t] = (svc[1] || [])[0];
    } catch { /* sem bootstrap → só o mapa */ }
  }
  return BOOTSTRAP[tld] || null;
}

let _proxyAgent; // undefined=por-inicializar · null=sem proxy · ProxyAgent (lazy)
async function proxyDispatcher() {
  if (_proxyAgent !== undefined) return _proxyAgent || undefined;
  const p = process.env.RDAP_PROXY || process.env.WHOIS_PROXY;
  if (!p) { _proxyAgent = null; return undefined; }
  try { const { ProxyAgent } = await import('undici'); _proxyAgent = new ProxyAgent(p); } // rotear por IP da frota
  catch { _proxyAgent = null; }
  return _proxyAgent || undefined;
}

// tldts dá o apex; o TLD é o último label (os nossos são single-label: pt/no/se/fi/nl).
export function tldOf(domain) { return (getDomain(domain) || domain).split('.').pop().toLowerCase(); }
// Check síncrono p/ o router decidir o tier sem fetch (só cobre o mapa hardcoded).
export function rdapKnown(domain) { return !!RDAP_BASE[tldOf(domain)]; }

function parseRdap(j) {
  if (!j || typeof j !== 'object') return null;
  const events = Array.isArray(j.events) ? j.events : [];
  const evDate = (a) => events.find((x) => x.eventAction === a)?.eventDate || null;
  const created = evDate('registration');
  const expiry = evDate('expiration'); // oportunista: presente em gTLDs / futuro; ausente em .no/.nl/.fi
  let registrar = null;
  const reg = (Array.isArray(j.entities) ? j.entities : []).find((e) => (e.roles || []).includes('registrar'));
  if (reg) { const vc = reg.vcardArray?.[1] || []; registrar = vc.find((x) => x[0] === 'fn')?.[3] || reg.handle || null; }
  const cD = created ? new Date(created) : null;
  const eD = expiry ? new Date(expiry) : null;
  const now = Date.now();
  const dte = eD && !isNaN(eD) ? (eD.getTime() - now) / 86400000 : null;
  return {
    registrar: registrar ? String(registrar).slice(0, 255) : null,
    created: cD && !isNaN(cD) ? cD.toISOString() : null,
    expiry: eD && !isNaN(eD) ? eD.toISOString() : null,
    ageDays: cD && !isNaN(cD) ? Math.round((now - cD.getTime()) / 86400000) : null,
    expiringSoon: dte != null && dte > 0 && dte <= 90,
  };
}

async function fetchRdap(url, timeout) {
  let host = 'rdap'; try { host = 'rdap:' + new URL(url).host; } catch { /* url estranho */ }
  await acquire(host, RATE); // token bucket por registry host (partilhado via Redis) — LANÇA se sobre-orçamento
  const opts = { headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) };
  const disp = await proxyDispatcher(); if (disp) opts.dispatcher = disp;
  const r = await fetch(url, opts);
  if (r.status === 429 || r.status === 503) {
    const ra = parseInt(r.headers.get('retry-after') || '5', 10);
    await penalize(host, Number.isNaN(ra) ? 5 : ra); // backoff explícito p/ este registry
    const e = new Error(`rdap ${r.status}`); e.status = r.status; e.rateLimited = true; throw e;
  }
  if (!r.ok) return null; // 404 = domínio livre/desconhecido → cascata
  try { return await r.json(); } catch { return null; }
}

// Devolve a shape whois OU null (TLD sem RDAP / not found / vazio → o router cascata).
// LANÇA em 429/503 (rate limit) p/ o job fazer nak+backoff — NUNCA martelar o registry.
export async function lookupRdap(domain, { timeout = TIMEOUT } = {}) {
  const apex = getDomain(domain) || domain;
  const base = await bootstrapBase(tldOf(apex));
  if (!base) return null; // TLD sem RDAP
  const url = (base.endsWith('/') ? base : base + '/') + 'domain/' + apex;
  const j = await fetchRdap(url, timeout);
  if (!j) return null;
  const out = parseRdap(j);
  // Referral registry→registrar (como o `follow:1` do whoiser): se faltar tudo, seguir 1x.
  if (out && !out.registrar && !out.created) {
    const rel = (j.links || []).find((l) => l.rel === 'related' && /rdap/i.test(l.href || l.value || ''));
    if (rel?.href) { const j2 = await fetchRdap(rel.href, timeout).catch(() => null); if (j2) { const o2 = parseRdap(j2); if (o2 && (o2.registrar || o2.created)) return o2; } }
  }
  return out;
}
