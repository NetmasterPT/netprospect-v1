// audit-cheap.js
//
// Backfill da auditoria "barata" para sites JÁ enriquecidos por versões antigas do
// enrich-sites.js (pt/no) que não têm os campos novos. Para cada site:
//   1 fetch da homepage -> social / GMB-sinal / cPanel / tempo de carga / localidade
//   DNS TXT             -> SPF / DMARC
//   rollup              -> has_email / has_phone (company.general_* OU contacto-pessoa)
// Idempotente e retomável via `sites.cheap_checked_at`.
//
// Uso:
//   node audit-cheap.js                       (todos os que faltam)
//   node audit-cheap.js --qualified           (só qualificados primeiro)
//   node audit-cheap.js --limit=100 --concurrency=20
//   node audit-cheap.js --force               (reprocessa mesmo com cheap_checked_at)

import { domainToASCII } from 'node:url';
import { readItems, updateItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { extractSocial, socialFlags } from './lib/audit/social.js';
import { detectGmb } from './lib/audit/gmb.js';
import { detectCpanel } from './lib/audit/cpanel.js';
import { bucketLoad } from './lib/audit/load.js';
import { extractBusinessLocation } from './lib/audit/locality.js';
import { checkEmailAuth } from './lib/audit/emailauth.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const f = argv.find((a) => a.startsWith(`--${name}=`)); return f ? f.split('=').slice(1).join('=') : dflt; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '20'), 10) || 20);
const QUALIFIED = argv.includes('--qualified');
const FORCE = argv.includes('--force');
const PAGE = 500;

const TIMEOUT_MS = 12000;
const MAX_HTML = 2_000_000;
const UA = 'netprospect-enrich/1.0 (+https://netmaster.pt; prospecao B2B)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (v, max = 255) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

const isTransientErr = (e) =>
  /fetch failed|ECONNRESET|socket hang up|terminated|network|ETIMEDOUT|EAI_AGAIN|502|503|429/i.test(
    (e && (e.message || '')) + JSON.stringify(e?.errors || '')
  );
async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (!isTransientErr(e) || i >= tries) throw e; await sleep(300 * i); }
  }
}

async function tryFetch(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' } });
    const ct = r.headers.get('content-type') || '';
    let html = '';
    if (/text\/html|xml|^$/.test(ct)) html = (await r.text()).slice(0, MAX_HTML);
    else { try { await r.body?.cancel(); } catch { /* ignora */ } }
    const elapsedMs = Math.round(performance.now() - t0);
    const headers = Object.fromEntries(r.headers.entries());
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    return { status: r.status, finalUrl: r.url, html, headers, setCookies, elapsedMs };
  } catch { return null; }
  finally { clearTimeout(to); }
}

async function pool(items, n, worker) {
  let i = 0;
  async function next() {
    if (i >= items.length) return;
    const idx = i++;
    try { await worker(items[idx], idx); } catch (e) { console.error(`  ! ${items[idx]?.domain}: ${e.message}`); }
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next));
}

// Constrói o registo de auditoria barata para um site (fetch + DNS).
async function auditSite(site, { emailCompanies, phoneCompanies }) {
  const domain = site.domain;
  const ascii = domainToASCII(domain) || domain;
  const patch = {
    has_email: false, has_phone: false,
    social: null, social_facebook: false, social_instagram: false, social_linkedin: false, social_twitter: false,
    gmb: false, gmb_signal: null, gmb_url: null, gmb_place_id: null,
    is_cpanel: false, cpanel_signal: null,
    load_ms: null, load_bucket: null,
    spf_status: null, dmarc_status: null,
    business_city: null, business_region: null, business_address: null,
    cheap_checked_at: new Date().toISOString(),
  };

  // Rollup de contactos (Set em memória) + email/telefone geral da empresa.
  const co = site.company && typeof site.company === 'object' ? site.company : null;
  const cid = co ? co.id : site.company;
  patch.has_email = !!(co && co.general_email) || (cid != null && emailCompanies.has(cid));
  patch.has_phone = !!(co && co.general_phone) || (cid != null && phoneCompanies.has(cid));

  // SPF/DMARC (DNS TXT) — corre mesmo sem HTTP.
  try { const a = await checkEmailAuth(ascii); patch.spf_status = a.spf; patch.dmarc_status = a.dmarc; }
  catch { /* DNS indisponível */ }

  // Homepage (só se houver hipótese de estar viva)
  const url = site.final_url || `https://${ascii}/`;
  const resp = site.is_live === false ? null : await tryFetch(url);
  if (resp && resp.html) {
    const html = resp.html;
    const social = extractSocial(html);
    const sFlags = socialFlags(social);
    patch.social = social;
    patch.social_facebook = sFlags.facebook; patch.social_instagram = sFlags.instagram;
    patch.social_linkedin = sFlags.linkedin; patch.social_twitter = sFlags.twitter;
    const g = detectGmb(html);
    patch.gmb = g.gmb; patch.gmb_signal = clip(g.signal, 60); patch.gmb_url = clip(g.url); patch.gmb_place_id = clip(g.placeId);
    const cp = detectCpanel({ ptr: site.ptr, headers: resp.headers, setCookies: resp.setCookies, finalUrl: resp.finalUrl });
    patch.is_cpanel = cp.isCpanel; patch.cpanel_signal = clip(cp.signal);
    patch.load_ms = resp.elapsedMs ?? null; patch.load_bucket = bucketLoad(patch.load_ms);
    const loc = extractBusinessLocation(html);
    patch.business_city = clip(loc.city, 120); patch.business_region = clip(loc.region, 120); patch.business_address = clip(loc.address);
  }
  return patch;
}

// Companies que têm ≥1 contacto-pessoa com email/telefone (para o rollup has_*).
async function loadContactRollups(client) {
  const grab = async (field) => {
    const rows = await client.request(readItems('contacts', {
      groupBy: ['company'], aggregate: { count: 'id' },
      filter: { company: { _nnull: true }, [field]: { _nnull: true } }, limit: -1,
    }));
    return new Set(rows.map((r) => r.company).filter((v) => v != null));
  };
  const [emailCompanies, phoneCompanies] = await Promise.all([grab('email'), grab('phone')]);
  return { emailCompanies, phoneCompanies };
}

async function main() {
  const client = makeClient();
  console.log('A carregar rollups de contactos (companies com email/telefone)…');
  const rollups = await loadContactRollups(client);
  console.log(`  companies com email: ${rollups.emailCompanies.size} | com telefone: ${rollups.phoneCompanies.size}`);

  const baseFilter = {};
  if (!FORCE) baseFilter.cheap_checked_at = { _null: true };
  if (QUALIFIED) baseFilter.qualified = { _eq: true };

  const total = await client.request(readItems('sites', { filter: baseFilter, aggregate: { count: 'id' } }))
    .then((r) => Number(r?.[0]?.count?.id || 0)).catch(() => 0);
  console.log(`Sites a auditar (barato): ${total}${QUALIFIED ? ' (qualificados)' : ''}${FORCE ? ' [force]' : ''}${LIMIT ? ` [limite ${LIMIT}]` : ''}`);

  let processed = 0, withSocial = 0, withCity = 0, failed = 0;
  const fields = ['id', 'domain', 'final_url', 'is_live', 'ptr', 'qualified', 'company.id', 'company.general_email', 'company.general_phone'];

  // Paginação por cursor de `id` (funciona com ou sem --force; nunca reprocessa
  // nem entra em loop, mesmo que o filtro cheap_checked_at encolha à medida).
  let lastId = 0;
  for (;;) {
    if (LIMIT && processed >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - processed) : PAGE;
    const filter = { ...baseFilter, id: { _gt: lastId } };
    const sites = await client.request(readItems('sites', { filter, fields, sort: ['id'], limit: pageSize }));
    if (!sites.length) break;
    lastId = sites[sites.length - 1].id;

    await pool(sites, CONCURRENCY, async (site) => {
      try {
        const patch = await auditSite(site, rollups);
        await withRetry(() => client.request(updateItem('sites', site.id, patch)));
        processed++;
        if (patch.social_facebook || patch.social_instagram || patch.social_linkedin || patch.social_twitter) withSocial++;
        if (patch.business_city) withCity++;
        if (processed % 50 === 0) console.log(`  ${processed}/${total} | com social: ${withSocial} | com cidade: ${withCity} | falhas: ${failed}`);
      } catch (e) {
        failed++;
        console.error(`  ! ${site.domain}: ${e.errors ? JSON.stringify(e.errors) : e.message}`);
      }
    });
  }

  console.log(`\nConcluído. Processados: ${processed} | com social: ${withSocial} | com cidade: ${withCity} | falhas: ${failed}`);
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err); process.exit(1); });
