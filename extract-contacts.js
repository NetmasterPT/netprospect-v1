// extract-contacts.js
//
// Para cada site (por omissão, só os qualificados), rastreia a homepage +
// páginas de equipa/sobre/contactos e extrai contactos de PESSOAS (nome, cargo,
// email, telefone), gravando-os na coleção `contacts` do Directus, ligados à
// empresa e ao site. Guarda a proveniência (source='site', source_detail=URL)
// e a base legal RGPD ('legitimate_interest').
//
// Uso:
//   node extract-contacts.js                    (sites qualificados ainda não processados)
//   node extract-contacts.js --all              (todos os sites live, não só qualificados)
//   node extract-contacts.js --limit=30 --force
//
// É best-effort (v1): a deteção de nome/cargo é heurística. Ver lib/contacts.js.

import { pathToFileURL } from 'node:url';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { findContactLinks, extractPeople } from './lib/contacts.js';
import { tldToCountry } from './lib/phone.js';

export { makeClient };

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '10'), 10) || 10);
const ALL = argv.includes('--all');
const FORCE = argv.includes('--force');
const TLD = flag('tld', null); // ex: --tld=se -> só sites *.se (permite streams por-TLD sem sobreposição)
// --shard=i/N: distribui os sites por N workers/VMs (hash(domain)%N==i) sem sobreposição.
// Combina com --tld. Ex.: 3 VMs a extrair .pt = --tld=pt --shard=0/3 … --shard=2/3.
function shardHash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function parseShard(v) { if (!v) return null; const m = String(v).match(/^(\d+)\s*\/\s*(\d+)$/); if (!m) throw new Error(`--shard inválido: "${v}" (usa i/N, ex. 2/5)`); const i = +m[1], n = +m[2]; if (n < 1 || i < 0 || i >= n) throw new Error(`--shard fora de gama: ${i}/${n}`); return { i, n }; }
const SHARD = parseShard(flag('shard', null));

const TIMEOUT_MS = 12000;
const MAX_HTML = 1_500_000;
const MAX_CONTACT_PAGES = 3;
const UA = 'netprospect-contacts/1.0 (+https://netmaster.pt; prospecao B2B)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Erros transitórios (Directus sob pressão / rede) -> repetir.
const isTransientErr = (e) =>
  /fetch failed|ECONNRESET|socket hang up|terminated|network|ETIMEDOUT|EAI_AGAIN|500|502|503|504|429|SERVICE_UNAVAILABLE|under pressure|unavailable/i.test(
    (e && (e.message || '')) + JSON.stringify(e?.errors || '')
  );
async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (!isTransientErr(e) || i >= tries) throw e; await sleep(400 * i); }
  }
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html|xml|^$/.test(ct)) { try { await r.body?.cancel(); } catch { /* ignora */ } return null; }
    return { url: r.url, html: (await r.text()).slice(0, MAX_HTML) };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
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

// Cria um contacto se ainda não existir para a empresa (idempotente).
async function upsertContact(client, person, companyId, siteId) {
  const filter = { company: { _eq: companyId } };
  if (person.email) filter.email = { _eq: person.email };
  else { filter.name = { _eq: person.name }; filter.role = { _eq: person.role }; }
  const exists = await client.request(readItems('contacts', { filter, fields: ['id'], limit: 1 }));
  if (exists.length) return false;
  // clip: os campos varchar do Directus são 255 — cortar evita que UM valor
  // demasiado longo (ex.: email mal-extraído de blob) rebente o insert do lote.
  const clip = (v, n = 255) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);
  await client.request(createItem('contacts', {
    name: clip(person.name),
    role: clip(person.role),
    role_category: clip(person.role_category || 'unknown'),
    email: clip(person.email),
    phone: clip(person.phone, 40),
    phone_country: clip(person.phone_country || null, 8),
    social_profiles: person.social_profiles || null,
    source: 'site',
    source_detail: clip(person.source_detail),
    company: companyId,
    site: siteId,
    gdpr_basis: 'legitimate_interest',
  }));
  return true;
}

export async function processSite(client, site) {
  const base = site.final_url || `https://${site.domain}/`;
  const defaultCountry = tldToCountry(site.domain, site.ip_country);
  const home = await fetchHtml(base);
  const pages = [];
  if (home) {
    pages.push(home);
    for (const link of findContactLinks(home.html, home.url).slice(0, MAX_CONTACT_PAGES)) {
      const p = await fetchHtml(link);
      if (p) pages.push(p);
    }
  }

  // Extrai e deduplica dentro do site.
  const found = [];
  const seen = new Set();
  for (const pg of pages) {
    for (const person of extractPeople(pg.html, pg.url, { defaultCountry })) {
      const key = person.email || `${person.name}|${person.role}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      found.push(person);
    }
  }

  let created = 0;
  for (const person of found) {
    if (await upsertContact(client, person, site.company, site.id)) created++;
  }
  // Rollup has_email/has_phone/has_decision_maker (monotónico: só liga, nunca desliga).
  const patch = { contacts_checked_at: new Date().toISOString() };
  if (found.some((p) => p.email)) patch.has_email = true;
  if (found.some((p) => p.phone)) patch.has_phone = true;
  if (found.some((p) => p.role_category === 'decision_maker')) patch.has_decision_maker = true;
  await client.request(updateItem('sites', site.id, patch));
  return created;
}

async function main() {
  const client = makeClient();

  const filter = ALL ? { is_live: { _eq: true } } : { qualified: { _eq: true } };
  if (!FORCE) filter.contacts_checked_at = { _null: true };
  filter.company = { _nnull: true };
  if (TLD) filter.domain = { _ends_with: '.' + TLD.replace(/^\.+/, '').toLowerCase() };

  let sites = await withRetry(() => client.request(
    readItems('sites', { filter, fields: ['id', 'domain', 'final_url', 'company'], limit: SHARD ? -1 : (LIMIT || -1), sort: ['domain'] })
  ), 5);
  if (SHARD) { sites = sites.filter((s) => (shardHash((s.domain || '').toLowerCase()) % SHARD.n) === SHARD.i); if (LIMIT) sites = sites.slice(0, LIMIT); }
  if (!sites.length) { console.log('Nada a fazer (todos processados ou nenhum corresponde ao filtro).'); return; }
  console.log(`Extração de contactos de ${sites.length} sites${TLD ? ` .${TLD}` : ''}${SHARD ? ` [shard ${SHARD.i}/${SHARD.n}]` : ''} (${ALL ? 'todos live' : 'qualificados'}), concorrência ${CONCURRENCY}...`);

  let done = 0, withContacts = 0, totalContacts = 0;
  await pool(sites, CONCURRENCY, async (site) => {
    const created = await processSite(client, site);
    done++;
    if (created) { withContacts++; totalContacts += created; }
    if (done % 10 === 0 || done === sites.length) {
      console.log(`  ${done}/${sites.length} | sites c/ contactos: ${withContacts} | contactos novos: ${totalContacts}`);
    }
    await sleep(100);
  });

  console.log(`\nConcluído. Sites processados: ${done} | com contactos: ${withContacts} | contactos criados: ${totalContacts}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err);
    process.exit(1);
  });
}
