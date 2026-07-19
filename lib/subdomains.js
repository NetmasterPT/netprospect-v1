// lib/subdomains.js
// Descoberta de subdomínios MULTI-FONTE com fallback. O crt.sh (PG público) é cronicamente
// instável/em-baixo → certspotter (CT log, grátis) passa a fonte primária, com crt.sh (HTTP + PG),
// SecurityTrails e Censys como fontes adicionais (as duas últimas gated em API key), e subfinder
// (CLI, agrega dezenas de fontes) se instalado. Faz-se merge + dedup de tudo o que responder; uma
// fonte a falhar NÃO derruba as outras. Só se TODAS falharem (rede/rate-limit) é que lança (nak/retry).
//
// Egresso: os fetches usam o dispatcher do egress (EGRESS_PROXY → exit node residencial) quando ativo.

import { fetchNames as crtshPgNames } from './crtsh.js';
import { egressDispatcher } from './egress.js';
import { execFile } from 'node:child_process';

// Hostnames plausíveis (exclui nomes de organização, emails, wildcards, etc.).
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const UA = 'NetProspect/1.0 (+subdomain-discovery)';

const clean = (d) => (d || '').toLowerCase().trim().replace(/^\*\./, '');

// Timeout DURO por fonte — uma fonte pendurada (ex.: crt.sh PG em baixo) não pode bloquear as outras.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => { const e = new Error(`${label} timeout (unavailable)`); e.transient = true; reject(e); }, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// GET JSON com timeout + egress proxy. 429/5xx → erro `transient` (para o nak/retry a montante).
async function jget(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, dispatcher: egressDispatcher(), signal: ctrl.signal });
    if (r.status === 429 || r.status >= 500) { const e = new Error(`HTTP ${r.status} (unavailable)`); e.transient = true; throw e; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

// --- fontes (cada uma devolve string[] de hostnames, ou null se DESATIVADA) ------------------------

// certspotter — CT log (SSLMate). Sem key: free tier muito limitado (429 em escala). Com CERTSPOTTER_API_KEY
// (conta SSLMate grátis) o limite sobe bastante. Todas as emissões que cobrem o domínio.
async function certspotter(domain) {
  const url = `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}`
    + '&include_subdomains=true&expand=dns_names';
  const key = process.env.CERTSPOTTER_API_KEY;
  const data = await jget(url, { timeoutMs: 25000, headers: key ? { Authorization: `Bearer ${key}` } : {} });
  const out = [];
  for (const iss of (Array.isArray(data) ? data : [])) for (const n of (iss.dns_names || [])) out.push(n);
  return out;
}

// crt.sh HTTP API — quando o site deles está up (complementa a PG, que oscila).
async function crtshHttp(domain) {
  const url = `https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`;
  const data = await jget(url, { timeoutMs: 25000 });
  const out = [];
  for (const row of (Array.isArray(data) ? data : [])) for (const n of String(row.name_value || '').split(/\n+/)) out.push(n);
  return out;
}

// crt.sh PG (a fonte antiga; réplica pública instável). Poucas retries — é o menos fiável.
async function crtshPg(domain) {
  const { names } = await crtshPgNames(domain, { activeOnly: true, maxRetries: 2, delayMs: 400 });
  return names;
}

// SecurityTrails — API (gated em SECURITYTRAILS_API_KEY). Devolve labels → append .domain.
async function securitytrails(domain) {
  const key = process.env.SECURITYTRAILS_API_KEY;
  if (!key) return null; // desativada sem key
  const data = await jget(`https://api.securitytrails.com/v1/domain/${encodeURIComponent(domain)}/subdomains?children_only=false`, { headers: { APIKEY: key } });
  return (data.subdomains || []).map((s) => `${s}.${domain}`);
}

// Censys — API v2 de certificados (gated em CENSYS_API_ID + CENSYS_API_SECRET).
async function censys(domain) {
  const id = process.env.CENSYS_API_ID, secret = process.env.CENSYS_API_SECRET;
  if (!id || !secret) return null; // desativada sem credenciais
  const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
  const data = await jget(`https://search.censys.io/api/v2/certificates/search?q=${encodeURIComponent('names: ' + domain)}&per_page=100`, { headers: { Authorization: auth } });
  const out = [];
  for (const hit of (data.result?.hits || [])) for (const n of (hit.names || [])) out.push(n);
  return out;
}

// subfinder — CLI da ProjectDiscovery (agrega dezenas de fontes passivas). null se não instalado.
function subfinder(domain) {
  return new Promise((resolve) => {
    execFile('subfinder', ['-d', domain, '-silent', '-timeout', '20'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve(null); // binário ausente → fonte desativada
      resolve(String(stdout || '').split(/\n+/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

const SOURCES = [
  ['certspotter', certspotter],
  ['crtsh_http', crtshHttp],
  ['crtsh_pg', crtshPg],
  ['securitytrails', securitytrails],
  ['censys', censys],
  ['subfinder', subfinder],
];

// Descobre subdomínios de `domain` combinando TODAS as fontes disponíveis (em paralelo).
// Devolve { names, sources } — names = *.domain válidos (dedup, ordenado); sources = {fonte: nº-novos}.
// Uma fonte desativada (sem key/binário) devolve null e é ignorada. Se pelo menos uma fonte
// respondeu (mesmo com 0 nomes) → sucesso (o domínio pode não ter subs). Se TODAS as ativas
// falharam por erro → lança com `unavailable` na mensagem (isTransientJobErr → nak/retry).
export async function discoverSubdomains(domain, { sources = SOURCES } = {}) {
  const d = clean(domain);
  const suffix = `.${d}`;
  // subfinder agrega dezenas de fontes e demora ~60s (execFile timeout 60s); os outros (HTTP/PG)
  // resolvem em <25s pelos seus próprios timeouts → dá 65s ao subfinder, 30s aos restantes.
  const results = await Promise.allSettled(sources.map(async ([name, fn]) => ({ name, names: await withTimeout(Promise.resolve(fn(d)), name === 'subfinder' ? 65000 : 30000, name) })));

  const seen = new Set();
  const bySource = {};
  let anyOk = false, allTransient = true, hadError = false;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.names == null) continue; // fonte desativada (sem key/binário)
      anyOk = true;
      let added = 0;
      for (let h of r.value.names) {
        h = clean(h);
        if ((h === d || h.endsWith(suffix)) && HOSTNAME_RE.test(h) && !seen.has(h)) { seen.add(h); added++; }
      }
      bySource[r.value.name] = added;
    } else {
      hadError = true;
      if (!r.reason?.transient) allTransient = false;
    }
  }
  if (!anyOk && hadError) {
    const e = new Error(`todas as fontes de subdomínios falharam (unavailable)`);
    e.transient = allTransient;
    throw e;
  }
  return { names: [...seen].sort(), sources: bySource };
}
