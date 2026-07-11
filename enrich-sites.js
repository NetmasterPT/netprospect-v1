// enrich-sites.js
//
// Lê uma lista de domínios (out/dominios_pt.txt) e, para cada um, enriquece e
// grava no Directus (coleção `sites` + `companies` + ligações a `platforms`):
//   DNS (IP + PTR) -> GeoIP (ASN/ISP/país) -> HTTP (liveness) ->
//   deteção híbrida de plataforma (fingerprints + simple-wappalyzer) ->
//   contactos gerais -> upsert idempotente.
//
// Uso:
//   node enrich-sites.js                                  (input out/dominios_pt.txt)
//   node enrich-sites.js --input=out/dominios_pt-test.txt --limit=30
//   node enrich-sites.js --concurrency=30 --no-wappalyzer --force
//
// Requer docker/.env + stack a correr + bootstrap-directus.js já executado.

import fs from 'fs';
import dns from 'node:dns/promises';
import { domainToASCII, pathToFileURL } from 'node:url';
import { getDomain } from 'tldts';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
// A2+ — hot-path do enrich via upserts PG diretos (contorna o Directus, o gargalo medido).
import { pgEnabled, pgUpsertSite, pgUpsertCompany, pgEnsurePlatforms } from './lib/pgwrite.js';
import { makeGeoIP } from './lib/geoip.js';
import { detectPlatforms, detectCDN, extractLang, extractContacts } from './lib/fingerprints.js';
import { tldToCountry } from './lib/phone.js';
import { qualify } from './lib/qualify.js';
import { scoreSite } from './lib/lead-score.js';
import { recordRun, metricsEnabled } from './lib/metrics.js';
import { orgDomain } from './lib/company.js';
import { updateGeoIP } from './update-geoip.js';
// Auditoria "barata" — sai do fetch da homepage que já fazemos + DNS TXT.
import { extractSocial, socialFlags } from './lib/audit/social.js';
import { detectGmb } from './lib/audit/gmb.js';
import { detectCpanel } from './lib/audit/cpanel.js';
import { bucketLoad } from './lib/audit/load.js';
import { extractBusinessLocation } from './lib/audit/locality.js';
import { checkEmailAuth } from './lib/audit/emailauth.js';

// --- Args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const f = argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : dflt;
};
const INPUT = flag('input', 'out/dominios_pt.txt');
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '30'), 10) || 30);
const NO_WAPP = argv.includes('--no-wappalyzer');
const FORCE = argv.includes('--force');
// Sharding p/ correr em VÁRIOS workers/VMs sem sobreposição: --shard=i/N processa só
// os domínios cujo hash%N==i (i em 0..N-1). Combina com --input/--limit. Ex.: 5 VMs =
// --shard=0/5 … --shard=4/5. Determinístico → cada domínio cai sempre no mesmo shard.
function shardHash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function parseShard(v) { if (!v) return null; const m = String(v).match(/^(\d+)\s*\/\s*(\d+)$/); if (!m) throw new Error(`--shard inválido: "${v}" (usa i/N, ex. 2/5)`); const i = +m[1], n = +m[2]; if (n < 1 || i < 0 || i >= n) throw new Error(`--shard fora de gama: ${i}/${n}`); return { i, n }; }
function inShard(d, shard) { return !shard || (shardHash(String(d).toLowerCase()) % shard.n) === shard.i; }
const SHARD = parseShard(flag('shard', null));
const CHECKPOINT = 'out/enrich-checkpoint.txt';

const TIMEOUT_MS = 12000;
const MAX_HTML = 2_000_000; // 2 MB
const UA = 'netprospect-enrich/1.0 (+https://netmaster.pt; prospecao B2B)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Erros transitórios (ligação ao Directus a saturar sob concorrência, rede).
// Inclui o SERVICE_UNAVAILABLE/"Under pressure" do limitador de pressão do Directus.
const isTransientErr = (e) =>
  /fetch failed|ECONNRESET|socket hang up|terminated|network|ETIMEDOUT|EAI_AGAIN|and_close|500|502|503|504|429|SERVICE_UNAVAILABLE|under pressure|unavailable/i.test(
    (e && (e.message || '')) + JSON.stringify(e?.errors || '')
  );

// Repete `fn` (idempotente) em erros transitórios — evita falhas e empresas órfãs.
async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientErr(e) || i >= tries) throw e;
      await sleep(300 * i);
    }
  }
}

// --- HTTP --------------------------------------------------------------------
async function tryFetch(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    const ct = r.headers.get('content-type') || '';
    let html = '';
    if (/text\/html|xml|^$/.test(ct)) {
      html = (await r.text()).slice(0, MAX_HTML);
    } else {
      try { await r.body?.cancel(); } catch { /* ignora */ }
    }
    const elapsedMs = Math.round(performance.now() - t0); // ~time-to-last-byte (lê o corpo)
    const headers = Object.fromEntries(r.headers.entries());
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    return { status: r.status, finalUrl: r.url, html, headers, setCookies, contentType: ct, elapsedMs };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

function extractTitle(html) {
  const m = (html || '').match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// --- Enriquecimento de um domínio -------------------------------------------
export async function enrichOne(domain, { geoip, analyze }) {
  const ascii = domainToASCII(domain) || domain;
  const rec = {
    domain: ascii,
    hosting_ip: null, ptr: null, asn: null, isp: null, ip_country: null, ip_city: null, cdn: null,
    is_live: false, http_status: null, final_url: null, redirects_www: false,
    language: null, tech_detected: null, qualified: false, qualified_reasons: [], primary_slug: null, matched: [],
    lead_score: null, lead_score_breakdown: null,
    general_email: null, general_phone: null, name: null,
    // Auditoria barata (preenchida abaixo se houver homepage)
    has_email: false, has_phone: false,
    social: null, social_facebook: false, social_instagram: false, social_linkedin: false, social_twitter: false,
    gmb: false, gmb_signal: null, gmb_url: null, gmb_place_id: null,
    is_cpanel: false, cpanel_signal: null,
    load_ms: null, load_bucket: null,
    spf_status: null, dmarc_status: null,
    business_city: null, business_region: null, business_address: null,
  };

  // 1) DNS (apex, depois www)
  for (const host of [ascii, `www.${ascii}`]) {
    try {
      const a = await dns.resolve4(host);
      if (a && a.length) { rec.hosting_ip = a[0]; break; }
    } catch { /* sem A */ }
  }
  if (rec.hosting_ip) {
    try { rec.ptr = (await dns.reverse(rec.hosting_ip))[0] || null; } catch { /* sem PTR */ }
    const geo = await geoip.lookup(rec.hosting_ip);
    rec.asn = geo.asn; rec.isp = geo.isp; rec.ip_country = geo.country; rec.ip_city = geo.city;
  } else {
    return rec; // domínio morto/sem A -> is_live=false
  }

  // Email auth (SPF/DMARC) — DNS TXT, independente do HTTP; corre mesmo se o site
  // não responder por HTTP mas resolver DNS. `null` = lookup transitório (não gravar).
  try {
    const auth = await checkEmailAuth(ascii);
    rec.spf_status = auth.spf; rec.dmarc_status = auth.dmarc;
  } catch { /* DNS indisponível — deixa null */ }

  // 2) HTTP liveness (1.º completo com status < 400)
  let resp = null;
  for (const u of [`https://${ascii}/`, `https://www.${ascii}/`, `http://${ascii}/`]) {
    const r = await tryFetch(u);
    if (!r) continue;
    if (!resp) resp = r;
    if (r.status < 400) { resp = r; break; }
  }
  if (!resp) return rec; // respondeu DNS mas não HTTP
  rec.http_status = resp.status;
  rec.final_url = resp.finalUrl;
  rec.is_live = resp.status < 400;
  try { rec.redirects_www = new URL(resp.finalUrl).hostname.startsWith('www.'); } catch { /* ignora */ }

  const html = resp.html || '';
  const headerBlob = JSON.stringify(resp.headers) + ' ' + (resp.setCookies || []).join(' ');

  // 3) Deteção híbrida (a qualificação v2 é calculada no fim, via lib/qualify.js)
  const fp = detectPlatforms(html, headerBlob);
  rec.primary_slug = fp.primarySlug;
  rec.matched = fp.matched;
  rec.cdn = detectCDN(resp.headers);
  rec.language = extractLang(html);
  rec.name = extractTitle(html);

  if (analyze && html && resp.status < 400) {
    try {
      const hdrsArr = {};
      for (const [k, v] of Object.entries(resp.headers)) hdrsArr[k] = [v];
      const tech = await analyze({ url: resp.finalUrl, html, headers: hdrsArr, statusCode: resp.status });
      if (Array.isArray(tech)) rec.tech_detected = tech.map((t) => ({ name: t.name, slug: t.slug, version: t.version || null, categories: (t.categories || []).map((c) => c.slug) }));
    } catch { /* wappalyzer opcional */ }
  }

  // 4) Contactos gerais (homepage; se nada, tenta /contactos e /contact).
  // País por omissão para telefones nacionais = TLD do site (senão ip_country).
  const phoneCountry = tldToCountry(ascii, rec.ip_country);
  let contacts = extractContacts(html, { defaultCountry: phoneCountry });
  if (!contacts.email && !contacts.phone) {
    for (const p of ['/contactos', '/contact']) {
      const r = await tryFetch(`${resp.finalUrl.replace(/\/$/, '')}${p}`);
      if (r && r.html) {
        contacts = extractContacts(r.html, { defaultCountry: phoneCountry });
        if (contacts.email || contacts.phone) break;
      }
    }
  }
  rec.general_email = contacts.email;
  rec.general_phone = contacts.phone;

  // 5) Auditoria barata a partir do MESMO html/headers/cookies (sem 2.º fetch)
  const social = extractSocial(html);
  const sFlags = socialFlags(social);
  rec.social = social; // arrays por rede
  rec.social_facebook = sFlags.facebook;
  rec.social_instagram = sFlags.instagram;
  rec.social_linkedin = sFlags.linkedin;
  rec.social_twitter = sFlags.twitter;

  const g = detectGmb(html);
  rec.gmb = g.gmb; rec.gmb_signal = g.signal;
  if (g.url) rec.gmb_url = g.url;
  if (g.placeId) rec.gmb_place_id = g.placeId;

  const cp = detectCpanel({ ptr: rec.ptr, headers: resp.headers, setCookies: resp.setCookies, finalUrl: resp.finalUrl });
  rec.is_cpanel = cp.isCpanel; rec.cpanel_signal = cp.signal;

  rec.load_ms = resp.elapsedMs ?? null;
  rec.load_bucket = bucketLoad(rec.load_ms);

  const loc = extractBusinessLocation(html);
  rec.business_city = loc.city; rec.business_region = loc.region; rec.business_address = loc.address;

  // Rollup mínimo (lower bound): o backfill/contactos refinam com os contactos-pessoa
  rec.has_email = !!rec.general_email;
  rec.has_phone = !!rec.general_phone;

  // Qualificação v2 + lead score (configuráveis). Os sinais de auditoria pesada
  // (seo/segurança/tráfego) ainda não existem aqui — o requalify/score-leads
  // reavaliam depois com o registo completo.
  const sig = {
    slug: rec.primary_slug, platforms: rec.matched, is_cpanel: rec.is_cpanel,
    spf_status: rec.spf_status, dmarc_status: rec.dmarc_status, gmb: rec.gmb,
    load_bucket: rec.load_bucket, has_email: rec.has_email, has_phone: rec.has_phone,
    security_findings: null, security_severity: null, seo_score: null, traffic_bucket: null,
    has_decision_maker: false,
  };
  const q = qualify(sig);
  rec.qualified = q.qualified;
  rec.qualified_reasons = q.reasons;
  const ls = scoreSite(sig);
  rec.lead_score = ls.score;
  rec.lead_score_breakdown = ls.breakdown;

  return rec;
}

// --- Upsert no Directus ------------------------------------------------------
// Trunca strings (campos são varchar(255) por omissão no Directus).
const clip = (v, max = 255) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);
const isUniqueErr = (e) => /RECORD_NOT_UNIQUE/.test(JSON.stringify(e?.errors || e?.message || ''));

export async function upsertSite(client, rec, platformIdBySlug, knownDomains) {
  // 1) Company (deduplicada por org_domain — ver lib/company.js)
  const org = orgDomain(rec.domain, rec.general_email, knownDomains);
  // Emails/telefones implausivelmente longos são quase sempre lixo de regex.
  const gEmail = rec.general_email && rec.general_email.length <= 150 ? rec.general_email : null;
  const gPhone = rec.general_phone && rec.general_phone.length <= 40 ? rec.general_phone : null;
  const coName = clip(rec.name || org, 255);
  const pids = rec.matched.filter((s) => platformIdBySlug[s]).map((s) => platformIdBySlug[s]);
  // 2) Site (chaveado por domain) — payload parametrizado pelo companyId.
  const buildSite = (companyId) => ({
    domain: clip(rec.domain),
    hosting_ip: clip(rec.hosting_ip, 45), ptr: clip(rec.ptr), asn: rec.asn, isp: clip(rec.isp),
    ip_country: clip(rec.ip_country, 10), ip_city: clip(rec.ip_city, 120),
    cdn: clip(rec.cdn, 50), is_live: rec.is_live, http_status: rec.http_status, final_url: clip(rec.final_url),
    redirects_www: rec.redirects_www, language: clip(rec.language, 30), tech_detected: rec.tech_detected,
    qualified: rec.qualified, qualified_reasons: rec.qualified_reasons, company: companyId,
    lead_score: rec.lead_score, lead_score_breakdown: rec.lead_score_breakdown, lead_score_at: new Date().toISOString(),
    primary_platform: rec.primary_slug ? platformIdBySlug[rec.primary_slug] || null : null,
    discovered_via: 'common_crawl',
    checked_at: new Date().toISOString(),
    has_email: rec.has_email, has_phone: rec.has_phone,
    social: rec.social,
    social_facebook: rec.social_facebook, social_instagram: rec.social_instagram,
    social_linkedin: rec.social_linkedin, social_twitter: rec.social_twitter,
    gmb: rec.gmb, gmb_signal: clip(rec.gmb_signal, 60), gmb_url: clip(rec.gmb_url), gmb_place_id: clip(rec.gmb_place_id),
    is_cpanel: rec.is_cpanel, cpanel_signal: clip(rec.cpanel_signal),
    load_ms: rec.load_ms, load_bucket: rec.load_bucket,
    spf_status: rec.spf_status, dmarc_status: rec.dmarc_status,
    business_city: clip(rec.business_city, 120), business_region: clip(rec.business_region, 120),
    business_address: clip(rec.business_address),
    cheap_checked_at: new Date().toISOString(),
  });

  let siteId;
  if (pgEnabled()) {
    // A2+ — DIRETO no PG (ON CONFLICT): 3 statements, ZERO Directus (o gargalo medido do enrich).
    const companyId = await pgUpsertCompany({ org_domain: clip(org), name: coName, website: clip(org), general_email: gEmail, general_phone: gPhone, country: clip(rec.ip_country, 10), source: 'website_crawl' });
    siteId = await pgUpsertSite(buildSite(companyId));
    await pgEnsurePlatforms(siteId, pids);
  } else {
    // --- Caminho Directus (original; fallback com DIRECT_PG_WRITE off) ---
    let companyId = null;
    const foundCo = await client.request(
      readItems('companies', { filter: { org_domain: { _eq: org } }, fields: ['id', 'name', 'website', 'general_email', 'general_phone', 'country'], limit: 1 })
    );
    if (foundCo.length) {
      const c = foundCo[0]; companyId = c.id;
      const patch = {};
      if (!c.name && coName) patch.name = coName;
      if (!c.website) patch.website = clip(org);
      if (!c.general_email && gEmail) patch.general_email = gEmail;
      if (!c.general_phone && gPhone) patch.general_phone = gPhone;
      if (!c.country && rec.ip_country) patch.country = clip(rec.ip_country, 10);
      if (Object.keys(patch).length) await client.request(updateItem('companies', companyId, patch));
    } else {
      const coPayload = { org_domain: clip(org), name: coName, website: clip(org), general_email: gEmail, general_phone: gPhone, country: clip(rec.ip_country, 10), source: 'website_crawl' };
      try { companyId = (await client.request(createItem('companies', coPayload))).id; }
      catch (e) {
        if (!isUniqueErr(e)) throw e;
        const again = await client.request(readItems('companies', { filter: { org_domain: { _eq: org } }, fields: ['id'], limit: 1 }));
        if (again.length) companyId = again[0].id; else throw e;
      }
    }
    const sitePayload = buildSite(companyId);
    const foundSite = await client.request(readItems('sites', { filter: { domain: { _eq: rec.domain } }, fields: ['id'], limit: 1 }));
    if (foundSite.length) { siteId = foundSite[0].id; await client.request(updateItem('sites', siteId, sitePayload)); }
    else { siteId = (await client.request(createItem('sites', sitePayload))).id; }
    if (pids.length) {
      const existing = await client.request(readItems('sites_platforms', { filter: { site: { _eq: siteId } }, fields: ['platform'], limit: -1 }));
      const havePlat = new Set(existing.map((j) => j.platform));
      for (const pid of pids) { if (!havePlat.has(pid)) await client.request(createItem('sites_platforms', { site: siteId, platform: pid })); }
    }
  }

  // 4) Fase E — observação de série temporal + deteção de mudança (fail-soft; só
  // com CLICKHOUSE_URL; só sites vivos têm sinais). Assim o path STANDALONE também
  // alimenta o ClickHouse, não só o DAG. Throttle interno colapsa re-corridas.
  if (metricsEnabled() && rec.is_live) {
    await recordRun({ id: siteId, domain: rec.domain }, {
      lead_score: rec.lead_score, qualified: rec.qualified ? 1 : 0, platform: rec.primary_slug || '',
      spf_status: rec.spf_status, dmarc_status: rec.dmarc_status, load_bucket: rec.load_bucket,
    }).catch(() => {});
  }
  return siteId;
}

// --- Contexto reutilizável (worker de jobs) ---------------------------------
// Inicializa uma vez o GeoIP, o wappalyzer, o catálogo de plataformas e (opcional)
// o conjunto de domínios conhecidos p/ corroborar fusões de empresa. Reutilizado
// pelo worker da fila (worker/worker.mjs) por cada job de enrich.
export async function createEnrichContext({ wappalyzer = true, loadKnownDomains = true, updateGeo = false } = {}) {
  const client = makeClient();
  if (updateGeo) { try { await updateGeoIP({}); } catch { /* usa bases existentes */ } }
  const geoip = await makeGeoIP();
  let analyze = null;
  if (wappalyzer) {
    try {
      const mod = await import('simple-wappalyzer');
      analyze = (mod.default && (mod.default.default || mod.default)) || mod;
      if (typeof analyze !== 'function') analyze = null;
    } catch { analyze = null; }
  }
  const plats = await client.request(readItems('platforms', { fields: ['id', 'slug'], limit: -1 }));
  const platformIdBySlug = Object.fromEntries(plats.map((p) => [p.slug, p.id]));
  const knownDomains = new Set();
  if (loadKnownDomains) {
    try {
      const all = await client.request(readItems('sites', { fields: ['domain'], limit: -1 }));
      for (const s of all) knownDomains.add(getDomain(s.domain) || s.domain);
    } catch { /* coleção vazia */ }
  }
  return { client, geoip, analyze, platformIdBySlug, knownDomains };
}

// --- Pool de concorrência ----------------------------------------------------
async function pool(items, n, worker) {
  let i = 0;
  async function next() {
    if (i >= items.length) return;
    const idx = i++;
    try { await worker(items[idx], idx); } catch (e) { console.error(`  ! ${items[idx]}: ${e.message}`); }
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next));
}

// --- Main --------------------------------------------------------------------
async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`Input não encontrado: ${INPUT} (usa --input=... ; ex: out/dominios_pt-test.txt)`);
    process.exit(1);
  }
  let domains = fs.readFileSync(INPUT, 'utf8').split('\n').map((d) => d.trim().toLowerCase()).filter(Boolean);
  // Conjunto de domínios conhecidos (para corroborar fusões de empresa por email).
  const knownDomains = new Set(domains.map((d) => getDomain(d) || d));

  const client = makeClient();
  // Atualiza as bases GeoLite2 se houver license key e estiverem em falta/velhas (>2 semanas).
  try {
    const r = await updateGeoIP({});
    if (r.updated?.length) console.log(`GeoIP: bases atualizadas [${r.updated.join(', ')}]`);
  } catch (e) {
    console.warn(`GeoIP: atualização falhou (${e.message}) — a usar bases existentes/fallback.`);
  }
  const geoip = await makeGeoIP();
  console.log(`GeoIP: modo ${geoip.mode}${geoip.mode === 'cymru' ? ' (sem .mmdb — fallback Team Cymru)' : ''}`);

  let analyze = null;
  if (!NO_WAPP) {
    const mod = await import('simple-wappalyzer');
    analyze = (mod.default && (mod.default.default || mod.default)) || mod;
    if (typeof analyze !== 'function') { console.warn('simple-wappalyzer não exportou função; a desligar.'); analyze = null; }
  }

  // Catálogo de plataformas: slug -> id
  const plats = await client.request(readItems('platforms', { fields: ['id', 'slug'], limit: -1 }));
  const platformIdBySlug = Object.fromEntries(plats.map((p) => [p.slug, p.id]));

  // Resume: domínios já processados (Directus checked_at + checkpoint local).
  // Filtra pelo TLD do input — evita puxar 250k domínios de outros TLDs e reduz
  // muito a pressão sobre o Directus (crucial quando vários enrich correm juntos).
  const tldSuffix = '.' + (domains[0]?.split('.').pop() || '').toLowerCase();
  const done = new Set();
  if (!FORCE) {
    try {
      const checked = await withRetry(() => client.request(readItems('sites', {
        filter: { checked_at: { _nnull: true }, domain: { _ends_with: tldSuffix } },
        fields: ['domain'], limit: -1,
      })), 5);
      for (const s of checked) done.add(s.domain);
    } catch (e) { console.warn(`Resume: query falhou (${e.message}) — a começar sem set de resume.`); }
    if (fs.existsSync(CHECKPOINT)) for (const d of fs.readFileSync(CHECKPOINT, 'utf8').split('\n')) if (d.trim()) done.add(d.trim());
  }

  let queue = domains.filter((d) => !done.has(domainToASCII(d) || d));
  if (SHARD) queue = queue.filter((d) => inShard(d, SHARD));
  if (LIMIT) queue = queue.slice(0, LIMIT);
  console.log(`Total input: ${domains.length} | já feitos: ${done.size}${SHARD ? ` | shard ${SHARD.i}/${SHARD.n}` : ''} | a processar agora: ${queue.length} | concorrência: ${CONCURRENCY}`);

  fs.mkdirSync('out', { recursive: true });
  const ckStream = fs.createWriteStream(CHECKPOINT, { flags: 'a' });

  let processed = 0, live = 0, qualified = 0, failed = 0;
  await pool(queue, CONCURRENCY, async (domain) => {
    try {
      const rec = await enrichOne(domain, { geoip, analyze });
      await withRetry(() => upsertSite(client, rec, platformIdBySlug, knownDomains));
      ckStream.write(rec.domain + '\n');
      processed++;
      if (rec.is_live) live++;
      if (rec.qualified) qualified++;
      if (processed % 10 === 0 || processed === queue.length) {
        console.log(`  ${processed}/${queue.length} | live: ${live} | qualificados: ${qualified} | falhas: ${failed}`);
      }
    } catch (e) {
      failed++;
      console.error(`  ! upsert ${domain}: ${e.errors ? JSON.stringify(e.errors) : e.message}`);
    }
  });

  ckStream.end();
  console.log(`\nConcluído. Processados: ${processed} | live: ${live} | qualificados: ${qualified} | falhas: ${failed}`);
}

// Só corre o CLI quando invocado diretamente (não quando importado pelo worker).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err);
    process.exit(1);
  });
}
