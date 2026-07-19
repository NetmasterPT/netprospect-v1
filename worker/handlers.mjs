// worker/handlers.mjs
// Handlers FINOS (Fase B) — um por passo. Cada um lê os seus inputs (snapshot do
// MinIO ou a linha do site no Directus), escreve os seus campos e PUBLICA os
// sucessores (DAG orientado a eventos, sem orquestrador central).
//
// DAG:
//   fetch  ──▶ {geoip? via dns} · fingerprint · social · locality · contacts · industry · traffic · emailauth
//   dns    ──▶ geoip
//   (qualquer passo que mude sinais) ──▶ score
//   score (qualificado, 1.ª vez, AUDIT_ENABLED) ──▶ {lighthouse.mobile, nuclei, ssl, whois, dnsprovider, (gmb)}
//
// Reutiliza as funções puras de lib/* já existentes.

import dns from 'node:dns/promises';
import tls from 'node:tls';
import fs from 'node:fs';
import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';
import { readItems, createItem } from '@directus/sdk';
// updateItem shadow: p/ sites/companies com DIRECT_PG_WRITE on, escreve direto no PG
// (via PgBouncer), contornando o Directus REST. Off → comando Directus normal. (A2)
import { updateItemMaybePg as updateItem, wrapClientPg, pgEnabled, pgCompanyContactKeys, pgInsertContacts, contactKey } from '../lib/pgwrite.js';
import { publishJob, SUBJECTS } from '../lib/jobs.js';
import { putSnapshot, getSnapshot } from '../lib/artifacts.js';
import { analyzeSslLabs } from '../lib/audit/ssllabs.js';
import { detectPlatforms, detectCDN, extractLang, extractContacts } from '../lib/fingerprints.js';
import { orgDomain } from '../lib/company.js';
import { tldToCountry, ccTldCountry, extractPhones } from '../lib/phone.js';
import { qualify } from '../lib/qualify.js';
import { scoreSite } from '../lib/lead-score.js';
import { recordRun, metricsEnabled, capture } from '../lib/metrics.js';
import { generateEmail } from '../lib/campaign-ai.js';
import { sendEmail } from '../lib/mailer.js';
import { extractSocial, socialFlags } from '../lib/audit/social.js';
import { detectGmb } from '../lib/audit/gmb.js';
import { detectCpanel } from '../lib/audit/cpanel.js';
import { bucketLoad } from '../lib/audit/load.js';
import { extractBusinessLocation } from '../lib/audit/locality.js';
import { checkEmailAuth } from '../lib/audit/emailauth.js';
import { extractPeople } from '../lib/contacts.js';
import { findContactLinks } from '../lib/contacts.js';
import { egressDispatcher } from '../lib/egress.js';
import { makeProviderPool } from '../lib/verify-providers.js';
import { makeReacherPool } from '../lib/reacher.js';
import { verifyDomain } from '../lib/verify-core.js';
import { redisClient } from '../lib/worker-telemetry.js';

const UA = 'netprospect-enrich/1.0 (+https://netmaster.pt; prospecao B2B)';
const TIMEOUT_MS = 12000;
const MAX_HTML = 1_500_000;
const clip = (v, n = 255) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);
const AUDIT_ENABLED = /^(1|true|yes)$/i.test(process.env.AUDIT_ENABLED || '');
// Backfill de saúde de domínio: saltar o `score` recompute por-job (a cascata que
// satura o CPU). O grau SSL / registrar quase não mexe a qualificação → correr
// score-leads.js UMA vez no fim em vez de recomputar por cada ssl/whois. Ver README.
const SKIP_DH_SCORE = /^(1|true|yes)$/i.test(process.env.DOMAIN_HEALTH_SKIP_SCORE || '');
const GMB_ENABLED = /^(1|true|yes)$/i.test(process.env.GMB_ENABLED || '');
const VERIFY_MAX_CAND = Math.max(1, parseInt(process.env.VERIFY_MAX_CANDIDATES || '4', 10));

// Pool de verificação partilhado por worker. Lazy: só constrói quando o 1.º job `verify` chega. As chaves
// free vêm de config/verify-providers.json. A QUOTA DIÁRIA é contabilizada + lockada no REDIS (partilhada por
// todos os workers e entre restarts; reset diário automático) — ver makeProviderPool. Fail-soft se Redis em baixo.
let _vpool = null;
async function verifyPool() {
  if (!_vpool) {
    const redis = await redisClient().catch(() => null);
    const providers = makeProviderPool(undefined, { redis });
    _vpool = { providers, reacher: makeReacherPool(), mxCache: new Map() };
  }
  // Reconcilia a quota com o Redis a cada job (locks de outros workers + viragem do dia, sem depender de restart).
  await _vpool.providers.loadState();
  return _vpool;
}

async function tryFetch(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, dispatcher: egressDispatcher(), headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' } });
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

// Versões CMS mais recentes conhecidas (staleness). Carregado uma vez.
const CMS_LATEST = (() => { try { return JSON.parse(fs.readFileSync(new URL('../config/cms-latest.json', import.meta.url))); } catch { return {}; } })();
const verNum = (v) => { const m = String(v || '').match(/(\d+)\.(\d+)/); return m ? parseInt(m[1], 10) * 1000 + parseInt(m[2], 10) : null; };
function cmsVersion(tech, slug) {
  if (!Array.isArray(tech) || !slug) return { version: null, outdated: false };
  const t = tech.find((x) => (x.slug === slug || String(x.name || '').toLowerCase().includes(slug)) && x.version);
  const version = t?.version || null;
  const dv = verNum(version), lv = verNum(CMS_LATEST[slug]);
  return { version, outdated: !!(dv && lv && dv < lv) };
}

export function makeFineHandlers(ctx, js) {
  const client = wrapClientPg(ctx.client, js);
  const pub = (subject, obj, msgId) => publishJob(js, subject, obj, msgId ? { msgId } : {});

  // Garante a linha do site (chave = domain); aplica patch; devolve id.
  async function ensureSite(domain, patch = {}) {
    const found = await client.request(readItems('sites', { filter: { domain: { _eq: domain } }, fields: ['id'], limit: 1 }));
    if (found.length) { if (Object.keys(patch).length) await client.request(updateItem('sites', found[0].id, patch)); return found[0].id; }
    try { return (await client.request(createItem('sites', { domain, discovered_via: 'queue', ...patch }))).id; }
    catch (e) {
      if (!/RECORD_NOT_UNIQUE/.test(JSON.stringify(e?.errors || e?.message || ''))) throw e;
      const again = await client.request(readItems('sites', { filter: { domain: { _eq: domain } }, fields: ['id'], limit: 1 }));
      if (again.length) { await client.request(updateItem('sites', again[0].id, patch)); return again[0].id; }
      throw e;
    }
  }
  // Empresa (dedup por org_domain) ligada ao site.
  async function ensureCompany(domain, generalEmail) {
    const org = orgDomain(domain, generalEmail, ctx.knownDomains);
    const found = await client.request(readItems('companies', { filter: { org_domain: { _eq: org } }, fields: ['id'], limit: 1 }));
    if (found.length) return found[0].id;
    try { return (await client.request(createItem('companies', { org_domain: clip(org), name: clip(org), website: clip(org), general_email: generalEmail || null, source: 'queue' }))).id; }
    catch { const a = await client.request(readItems('companies', { filter: { org_domain: { _eq: org } }, fields: ['id'], limit: 1 })); return a[0]?.id || null; }
  }
  const siteRow = (id, fields) => client.request(readItems('sites', { filter: { id: { _eq: id } }, fields, limit: 1 })).then((r) => r[0]);

  // Deteta páginas de anti-bot / WAF / IP-bloqueado (challenge, "just a moment", 403/429/503/415
  // com corpo mínimo). Estes sites TÊM de ser re-corridos a partir de um IP RESIDENCIAL (laptop);
  // processá-los daqui só envenenaria com o conteúdo da página-desafio.
  function isBlockedPage(status, html) {
    const h = html || '';
    if ([403, 429, 503, 415].includes(status) && h.length < 6000) return true;
    if (/just a moment|checking your browser|attention required|cf-browser-verification|__cf_chl|challenge-platform|enable javascript and cookies to continue|um momento, por favor|one moment, please|ddos-guard|access denied|request unsuccessful|verifying you are human/i.test(h)) return true;
    if (h.length > 0 && h.length < 900 && /<title>[^<]*(moment|loader|please wait|blocked|denied|attention)/i.test(h)) return true;
    return false;
  }

  // ---- ROOT: fetch (DNS + HTTP + snapshot) ---------------------------------
  async function handleFetch(job) {
    const domain = domainToASCII(job.domain) || job.domain;
    let hosting_ip = null, ptr = null;
    for (const host of [domain, `www.${domain}`]) { try { const a = await dns.resolve4(host); if (a?.length) { hosting_ip = a[0]; break; } } catch { /* sem A */ } }
    if (hosting_ip) { try { ptr = (await dns.reverse(hosting_ip))[0] || null; } catch { /* sem PTR */ } }
    const siteId = await ensureSite(domain, { hosting_ip: clip(hosting_ip, 45), ptr: clip(ptr), checked_at: new Date().toISOString() });
    // snapshotOnly: regenerar o snapshot (que foi podado do MinIO) + reclassificar SÓ a indústria,
    // sem re-correr os extractors partidos (contacts/social/locality) nem o enrich extra.
    if (!job.snapshotOnly) {
      if (hosting_ip) await pub(SUBJECTS.geoip, { domain, siteId, ip: hosting_ip }, `geoip:${domain}`);
      await pub(SUBJECTS.emailauth, { domain, siteId }, `emailauth:${domain}`);
      await pub(SUBJECTS.traffic, { domain, siteId }, `traffic:${domain}`);
    }
    if (!hosting_ip) { await client.request(updateItem('sites', siteId, { is_live: false })); return 'ack'; }

    let resp = null;
    for (const u of [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`]) { const r = await tryFetch(u); if (!r) continue; if (!resp) resp = r; if (r.status < 400) { resp = r; break; } }
    if (!resp) { await client.request(updateItem('sites', siteId, { is_live: false })); return 'ack'; }
    // Anti-bot / WAF / IP-bloqueado → marca p/ re-correr de IP residencial (laptop) e NÃO processa.
    if (isBlockedPage(resp.status, resp.html)) {
      await client.request(updateItem('sites', siteId, { blocked_datacenter: true, blocked_at: new Date().toISOString(), http_status: resp.status, final_url: clip(resp.finalUrl), is_live: true }));
      // Auto-encaminha p/ IP residencial (portátil), a menos que ESTE fetch já venha de lá (anti-loop).
      if (!job.residential) await pub(SUBJECTS.fetchResidential, { domain, residential: true }, `fetchres:${domain}`);
      return 'ack';
    }
    // Páginas de contacto (para o job contacts, sem re-fetch). No snapshotOnly a indústria não as
    // usa → salta (poupa ~3 fetches/site); ficam vazias e reenchem-se num fetch completo futuro.
    const pages = [];
    if (!job.snapshotOnly && resp.html) for (const link of findContactLinks(resp.html, resp.finalUrl).slice(0, 3)) { const p = await tryFetch(link); if (p?.html) pages.push({ url: p.finalUrl, html: p.html }); }
    const cp = detectCpanel({ ptr, headers: resp.headers, setCookies: resp.setCookies, finalUrl: resp.finalUrl });
    let redirects_www = false; try { redirects_www = new URL(resp.finalUrl).hostname.startsWith('www.'); } catch { /* ignora */ }
    await client.request(updateItem('sites', siteId, {
      is_live: resp.status < 400, http_status: resp.status, final_url: clip(resp.finalUrl), redirects_www,
      language: clip(extractLang(resp.html), 30), load_ms: resp.elapsedMs, load_bucket: bucketLoad(resp.elapsedMs),
      is_cpanel: cp.isCpanel, cpanel_signal: clip(cp.signal), cdn: clip(detectCDN(resp.headers), 50),
      blocked_datacenter: false, // fetch bom a partir do datacenter → limpa flag de bloqueio
    }));
    await putSnapshot(siteId, { finalUrl: resp.finalUrl, status: resp.status, headers: resp.headers, setCookies: resp.setCookies, html: resp.html, pages, fetchedAt: new Date().toISOString() });
    // Fan-out de análise (leem o snapshot). snapshotOnly → só reclassifica a indústria.
    const fanout = job.snapshotOnly ? [SUBJECTS.industry] : [SUBJECTS.fingerprint, SUBJECTS.social, SUBJECTS.locality, SUBJECTS.contacts, SUBJECTS.industry];
    for (const s of fanout) await pub(s, { domain, siteId });
    return 'ack';
  }

  // Opcional: re-resolver DNS isoladamente (o root `fetch` já resolve DNS).
  async function handleDns(job) {
    const domain = domainToASCII(job.domain) || job.domain;
    let hosting_ip = null, ptr = null;
    for (const host of [domain, `www.${domain}`]) { try { const a = await dns.resolve4(host); if (a?.length) { hosting_ip = a[0]; break; } } catch { /* sem A */ } }
    if (hosting_ip) { try { ptr = (await dns.reverse(hosting_ip))[0] || null; } catch { /* sem PTR */ } }
    const siteId = job.siteId || await ensureSite(domain, {});
    await client.request(updateItem('sites', siteId, { hosting_ip: clip(hosting_ip, 45), ptr: clip(ptr) }));
    if (hosting_ip) await pub(SUBJECTS.geoip, { domain, siteId, ip: hosting_ip }, `geoip:${domain}`);
    return 'ack';
  }

  async function handleGeoip(job) {
    const geo = await ctx.geoip.lookup(job.ip);
    // Fallback: IPs anycast/CDN (Cloudflare/One.com) resolvem ASN/ISP mas SEM país no MaxMind →
    // usa o ccTLD (.se→SE etc.; gTLD fica null). Ver ccTldCountry() e o marcador do geoip em COVERAGE_SQL.
    await client.request(updateItem('sites', job.siteId, { asn: geo.asn, isp: clip(geo.isp), ip_country: clip(geo.country || ccTldCountry(job.domain), 10), ip_city: clip(geo.city, 120) }));
    return 'ack';
  }

  async function handleFingerprint(job) {
    // Snapshot do MinIO; se não houver (ex.: sites enriquecidos pelo path standalone,
    // sem snapshot — backfill de CMS/plataforma), faz fetch da homepage.
    let snap = await getSnapshot(job.siteId);
    if (!snap?.html) {
      const home = await tryFetch(`https://${domainToASCII(job.domain) || job.domain}/`);
      if (!home?.html) return 'ack';
      snap = { html: home.html, finalUrl: home.finalUrl, headers: home.headers || {}, setCookies: home.setCookies || [], status: home.status };
    }
    const headerBlob = JSON.stringify(snap.headers || {}) + ' ' + (snap.setCookies || []).join(' ');
    const fp = detectPlatforms(snap.html, headerBlob);
    let tech = []; // sentinela "correu": [] (não null) quando o wappalyzer está ausente/lança/devolve não-array → conta na cobertura
    if (ctx.analyze) { try { const hdrs = {}; for (const [k, v] of Object.entries(snap.headers || {})) hdrs[k] = [v]; const t = await ctx.analyze({ url: snap.finalUrl, html: snap.html, headers: hdrs, statusCode: snap.status }); if (Array.isArray(t)) tech = t.map((x) => ({ name: x.name, slug: x.slug, version: x.version || null, categories: (x.categories || []).map((c) => c.slug) })); } catch { /* opcional */ } }
    const primaryId = fp.primarySlug ? ctx.platformIdBySlug[fp.primarySlug] || null : null;
    // Versão do CMS (do wappalyzer) + staleness vs config/cms-latest.json.
    const cms = cmsVersion(tech, fp.primarySlug);
    await client.request(updateItem('sites', job.siteId, { primary_platform: primaryId, tech_detected: tech, cms_version: clip(cms.version, 40), cms_outdated: cms.outdated }));
    // M2M plataformas
    for (const slug of fp.matched.filter((s) => ctx.platformIdBySlug[s])) {
      const pid = ctx.platformIdBySlug[slug];
      const ex = await client.request(readItems('sites_platforms', { filter: { site: { _eq: job.siteId }, platform: { _eq: pid } }, fields: ['id'], limit: 1 }));
      if (!ex.length) await client.request(createItem('sites_platforms', { site: job.siteId, platform: pid }));
    }
    // No backfill de cms em massa, NÃO re-scorar por-job (a cascata satura); DOMAIN_HEALTH_SKIP_SCORE
    // salta e corre-se `score-leads.js` UMA vez no fim (batch). Igual ao ssl/whois.
    if (!SKIP_DH_SCORE) await pub(SUBJECTS.score, { domain: job.domain, siteId: job.siteId }, `score:${job.domain}`);
    return 'ack';
  }

  async function handleSocial(job) {
    const snap = await getSnapshot(job.siteId); if (!snap?.html) return 'ack';
    // Social vive muitas vezes na página de contactos, não na homepage → varrer tudo.
    const allHtml = [snap.html, ...(snap.pages || []).map((p) => p.html)].filter(Boolean).join('\n');
    const social = extractSocial(allHtml); const f = socialFlags(social);
    const g = detectGmb(snap.html);
    await client.request(updateItem('sites', job.siteId, { social, social_facebook: f.facebook, social_instagram: f.instagram, social_linkedin: f.linkedin, social_twitter: f.twitter, social_youtube: f.youtube, social_tiktok: f.tiktok, social_pinterest: f.pinterest, social_whatsapp: f.whatsapp, whatsapp_number: clip(social.whatsapp_number, 32), gmb: g.gmb, gmb_signal: clip(g.signal, 60), gmb_url: clip(g.url), gmb_place_id: clip(g.placeId) }));
    await pub(SUBJECTS.score, { domain: job.domain, siteId: job.siteId }, `score:${job.domain}`);
    return 'ack';
  }

  async function handleLocality(job) {
    const snap = await getSnapshot(job.siteId); if (!snap?.html) return 'ack';
    // Morada vive muitas vezes na página de contactos → varrer homepage + páginas.
    let loc = extractBusinessLocation(snap.html);
    if (!loc.address || !loc.city) {
      for (const p of (snap.pages || [])) {
        if (!p?.html) continue;
        const l = extractBusinessLocation(p.html);
        loc = { city: loc.city || l.city, region: loc.region || l.region, address: loc.address || l.address, postalCode: loc.postalCode || l.postalCode };
        if (loc.address && loc.city) break;
      }
    }
    // locality_checked_at = marcador "correu" (a morada/cidade é condicional → não serve de marcador).
    await client.request(updateItem('sites', job.siteId, { business_city: clip(loc.city, 120), business_region: clip(loc.region, 120), business_address: clip(loc.address), locality_checked_at: new Date().toISOString() }));
    return 'ack';
  }

  async function handleEmailauth(job) {
    const domain = domainToASCII(job.domain) || job.domain;
    // checkEmailAuth devolve 'missing'/'ok'/'weak'/'invalid' (resposta real) OU null em DNS transitório
    // (SERVFAIL/timeout). Gravar null marcava o job como "correu" sem ter corrido → subcontava. Agora:
    // transitório → 'retry' (nak/backoff; ack gracioso ao fim das tentativas), nunca grava spf_status=null.
    try {
      const a = await checkEmailAuth(domain);
      if (a?.spf == null) return 'retry';
      await client.request(updateItem('sites', job.siteId, { spf_status: a.spf, dmarc_status: a.dmarc }));
    } catch { return 'retry'; /* DNS indisponível → re-tenta */ }
    await pub(SUBJECTS.score, { domain: job.domain, siteId: job.siteId }, `score:${job.domain}`);
    return 'ack';
  }

  async function handleTraffic(job) {
    const tr = ctx.audit?.tranco ? ctx.audit.tranco.trafficOf(job.domain) : { rank: null, bucket: 'unranked' };
    await client.request(updateItem('sites', job.siteId, { traffic_rank: tr.rank, traffic_bucket: tr.bucket }));
    await pub(SUBJECTS.score, { domain: job.domain, siteId: job.siteId }, `score:${job.domain}`);
    return 'ack';
  }

  async function handleContacts(job) {
    const site = await siteRow(job.siteId || 0, ['id', 'domain', 'company', 'ip_country', 'contacts_checked_at', 'final_url'])
      || (job.domain ? (await client.request(readItems('sites', { filter: { domain: { _eq: job.domain } }, fields: ['id', 'domain', 'company', 'ip_country', 'final_url'], limit: 1 })))[0] : null);
    if (!site) return 'ack';
    const defaultCountry = tldToCountry(site.domain, site.ip_country);
    // Snapshot do MinIO; se não houver (ex.: job coarse), faz fetch de recurso.
    let snap = await getSnapshot(site.id);
    if (!snap?.html) {
      const home = await tryFetch(site.final_url || `https://${site.domain}/`);
      if (!home?.html) { await client.request(updateItem('sites', site.id, { contacts_checked_at: new Date().toISOString() })); return 'ack'; }
      const pages = [];
      for (const link of findContactLinks(home.html, home.finalUrl).slice(0, 3)) { const p = await tryFetch(link); if (p?.html) pages.push({ url: p.finalUrl, html: p.html }); }
      snap = { finalUrl: home.finalUrl, html: home.html, pages };
    }
    // Empresa + email geral (do snapshot da homepage)
    const gen = extractContacts(snap.html || '', { defaultCountry });
    const companyId = site.company || await ensureCompany(site.domain, gen.email);
    const found = [];
    const seen = new Set();
    for (const pg of [{ url: snap.finalUrl, html: snap.html }, ...(snap.pages || [])]) {
      if (!pg?.html) continue;
      for (const p of extractPeople(pg.html, pg.url, { defaultCountry })) { const k = p.email || `${p.name}|${p.role}`; if (!k || seen.has(k)) continue; seen.add(k); found.push(p); }
    }
    // Telefones da empresa: TODOS os únicos (fixos+móveis) de TODAS as páginas — não só
    // da homepage e não colados a uma pessoa. `general_phone` = 1.º; `phones` = lista.
    const allHtml = [snap.html, ...(snap.pages || []).map((p) => p.html)].filter(Boolean).join('\n');
    const phones = extractPhones(allHtml, { defaultCountry, limit: 6 }).map((p) => p.e164);
    const generalEmail = gen.email || found.find((p) => p.email)?.email || null;
    // preenche emails/telefones gerais da empresa (só se vazios)
    if (generalEmail || phones.length) { try { const c = (await client.request(readItems('companies', { filter: { id: { _eq: companyId } }, fields: ['general_email', 'general_phone'], limit: 1 })))[0]; const cp = {}; if (!c?.general_email && generalEmail) cp.general_email = generalEmail; if (!c?.general_phone && phones.length) cp.general_phone = clip(phones[0], 40); if (phones.length) cp.phones = phones; if (Object.keys(cp).length) await client.request(updateItem('companies', companyId, cp)); } catch { /* ignora */ } }
    const mkContact = (p) => ({ name: p.name, role: p.role, role_category: p.role_category || 'unknown', email: p.email, phone: p.phone, phone_country: p.phone_country || null, social_profiles: p.social_profiles || null, source: 'site', source_detail: p.source_detail, company: companyId, site: site.id, gdpr_basis: 'legitimate_interest' });
    if (found.length) {
      if (pgEnabled()) {
        // A4 — 1 leitura de dedup + 1 INSERT multi-linha (vs N leituras + N inserts)
        const existing = await pgCompanyContactKeys(companyId);
        const fresh = found.filter((p) => !existing.has(contactKey(p)));
        if (fresh.length) await pgInsertContacts(fresh.map(mkContact));
      } else {
        for (const p of found) {
          const filter = { company: { _eq: companyId } };
          if (p.email) filter.email = { _eq: p.email }; else { filter.name = { _eq: p.name }; filter.role = { _eq: p.role }; }
          const ex = await client.request(readItems('contacts', { filter, fields: ['id'], limit: 1 }));
          if (ex.length) continue;
          await client.request(createItem('contacts', mkContact(p)));
        }
      }
    }
    const patch = { company: companyId, contacts_checked_at: new Date().toISOString() };
    patch.has_email = !!generalEmail || found.some((p) => p.email);
    patch.has_phone = phones.length > 0;
    if (found.some((p) => p.role_category === 'decision_maker')) patch.has_decision_maker = true;
    await client.request(updateItem('sites', site.id, patch));
    await pub(SUBJECTS.score, { domain: site.domain, siteId: site.id }, `score:${site.domain}`);
    return 'ack';
  }

  // ---- SCORE (convergência: qualify + lead score; dispara auditorias) -------
  const SCORE_FIELDS = ['id', 'domain', 'primary_platform.slug', 'is_cpanel', 'spf_status', 'dmarc_status', 'security_findings', 'security_severity', 'gmb', 'seo_score', 'has_email', 'has_phone', 'has_decision_maker', 'load_bucket', 'traffic_bucket', 'ssl_days_left', 'expiring_soon', 'cms_outdated', 'qualified', 'audit_checked_at'];
  async function handleScore(job) {
    const s = await siteRow(job.siteId, SCORE_FIELDS); if (!s) return 'ack';
    const sig = { slug: s.primary_platform?.slug, is_cpanel: s.is_cpanel, spf_status: s.spf_status, dmarc_status: s.dmarc_status, security_findings: s.security_findings, security_severity: s.security_severity, gmb: s.gmb, seo_score: s.seo_score, has_email: s.has_email, has_phone: s.has_phone, has_decision_maker: s.has_decision_maker, load_bucket: s.load_bucket, traffic_bucket: s.traffic_bucket, ssl_days_left: s.ssl_days_left, expiring_soon: s.expiring_soon, cms_outdated: s.cms_outdated };
    const q = qualify(sig); const ls = scoreSite(sig);
    const wasQualified = s.qualified;
    await client.request(updateItem('sites', job.siteId, { qualified: q.qualified, qualified_reasons: q.reasons, lead_score: ls.score, lead_score_breakdown: ls.breakdown, lead_score_at: new Date().toISOString() }));
    // Fase E — série temporal + deteção de mudança. FIRE-AND-FORGET (não bloqueia o
    // ack do score): o ClickHouse sai do caminho crítico. recordRun é fail-soft.
    if (metricsEnabled()) {
      recordRun({ id: job.siteId, domain: s.domain }, {
        lead_score: ls.score, qualified: q.qualified ? 1 : 0, platform: sig.slug || '',
        spf_status: sig.spf_status, dmarc_status: sig.dmarc_status, ssl_days_left: sig.ssl_days_left,
        expiring_soon: sig.expiring_soon ? 1 : 0, cms_outdated: sig.cms_outdated ? 1 : 0,
        seo_score: sig.seo_score, security_severity: sig.security_severity,
        has_decision_maker: sig.has_decision_maker ? 1 : 0, traffic_bucket: sig.traffic_bucket,
      }, { runId: job.runId || '' }).catch(() => {});
    }
    // 1.ª vez que fica qualificado, sem auditoria feita → dispara auditorias pesadas.
    if (AUDIT_ENABLED && q.qualified && !wasQualified && !s.audit_checked_at) {
      // Marca "entrou no pipeline de auditoria". O DAG fino (fan-out abaixo) nunca escrevia audit_checked_at
      // — só o handleAudit coarse legado — pelo que a linha `audit` da cobertura estava morta (~0). Stamp aqui.
      await client.request(updateItem('sites', job.siteId, { audit_checked_at: new Date().toISOString() })).catch(() => {});
      for (const subj of [SUBJECTS.lighthouseMobile, SUBJECTS.nuclei, SUBJECTS.ssl, SUBJECTS.whois, SUBJECTS.dnsprovider]) await pub(subj, { domain: job.domain, siteId: job.siteId }, `${subj}:${job.domain}`);
      if (GMB_ENABLED) await pub(SUBJECTS.gmb, { domain: job.domain, siteId: job.siteId }, `gmb:${job.domain}`);
    }
    return 'ack';
  }

  // ---- SSL / WHOIS / DNS provider (Fase D) ---------------------------------
  const sslGrade = (daysLeft, ok) => (!ok ? 'F' : daysLeft < 0 ? 'F' : daysLeft < 7 ? 'D' : daysLeft < 30 ? 'C' : daysLeft < 90 ? 'B' : 'A');
  async function handleSsl(job) {
    const domain = domainToASCII(job.domain) || job.domain;
    const cert = await new Promise((resolve) => {
      let done = false;
      const sock = tls.connect({ host: domain, port: 443, servername: domain, timeout: 10000, rejectUnauthorized: false }, () => { const c = sock.getPeerCertificate(); const authorized = sock.authorized; sock.end(); done = true; resolve(c && c.valid_to ? { ...c, authorized } : null); });
      sock.on('error', () => { if (!done) resolve(null); }); sock.on('timeout', () => { sock.destroy(); if (!done) resolve(null); });
    });
    if (cert) {
      const notAfter = new Date(cert.valid_to);
      const daysLeft = Math.round((notAfter - Date.now()) / 86400000);
      // Tipo de validação: OV/EV se o subject tem Organização (paga-se p/ validar a empresa);
      // DV se só tem CN (grátis: Let's Encrypt, ZeroSSL, cPanel AutoSSL-Sectigo…). Distingue o
      // Sectigo "pago" (OV) do Sectigo cPanel (DV). EV é raro/depreciado → dobrado em OV.
      const sslValidation = (cert.subject?.O && String(cert.subject.O).trim()) ? 'OV' : 'DV';
      // Wildcard: CN ou algum SAN começa por "*." (ex.: *.dominio.pt).
      const san = String(cert.subjectaltname || '');
      const sslWildcard = /(^|[\s:])\*\./.test(san) || String(cert.subject?.CN || '').startsWith('*.');
      await client.request(updateItem('sites', job.siteId, {
        ssl_issuer: clip(cert.issuer?.O || cert.issuer?.CN || null, 120),
        ssl_not_after: notAfter.toISOString(), ssl_days_left: daysLeft, ssl_grade: sslGrade(daysLeft, cert.authorized),
        ssl_validation: sslValidation, ssl_wildcard: sslWildcard,
      }));
      if (!SKIP_DH_SCORE) await pub(SUBJECTS.score, { domain: job.domain, siteId: job.siteId }, `score:${job.domain}`);
    } else {
      await client.request(updateItem('sites', job.siteId, { ssl_grade: 'F' })).catch(() => {}); // sem HTTPS
    }
    return 'ack';
  }
  // SSL Labs — análise profunda da configuração TLS (nota A+..F + avisos). Lento/rate-limited:
  // on-demand (botão) ou batch pequeno. job.fresh → força re-análise (senão usa cache <24h).
  async function handleSsllabs(job) {
    const domain = domainToASCII(job.domain) || job.domain;
    let siteId = job.siteId; // o path on-demand (/api/audit?only=ssllabs) não envia siteId → resolve
    if (!siteId) { const rows = await client.request(readItems('sites', { filter: { domain: { _eq: job.domain } }, fields: ['id'], limit: 1 })).catch(() => []); siteId = rows[0]?.id; }
    if (!siteId) return 'ack';
    const r = await analyzeSslLabs(domain, { fromCache: !job.fresh, maxAgeH: 24, timeoutMs: 300000 });
    if (r.status === 'READY') {
      await client.request(updateItem('sites', siteId, {
        ssllabs_grade: clip(r.grade, 6), ssllabs_checked_at: new Date().toISOString(),
        ssllabs_report: { grade: r.grade, hasWarnings: r.hasWarnings, gradeTrustIgnored: r.gradeTrustIgnored, endpoints: r.endpoints, testTime: r.testTime },
      })).catch(() => {});
    } else {
      // TIMEOUT/ERROR → marca checked_at p/ não repetir em loop (sem grade).
      await client.request(updateItem('sites', siteId, { ssllabs_checked_at: new Date().toISOString() })).catch(() => {});
    }
    return 'ack';
  }
  async function handleDnsprovider(job) {
    const domain = getDomain(job.domain) || job.domain;
    try { const ns = (await dns.resolveNs(domain)).map((n) => n.toLowerCase()); const provider = ns[0]?.split('.').slice(-2).join('.') || null; await client.request(updateItem('sites', job.siteId, { dns_provider: clip(provider, 120) })).catch(() => {}); } catch { /* sem NS */ }
    return 'ack';
  }
  async function handleWhois(job) {
    const domain = getDomain(job.domain) || job.domain;
    const { lookupWhois } = await import('../lib/whois.js');
    const w = await lookupWhois(domain); // router tiered; LANÇA em rate-limit → nak (não marca checked)
    // whois_checked_at SEMPRE (mesmo sem dados, ex.: .pt) → o resume salta-o 90d, não reprocessa eternamente.
    const patch = { whois_checked_at: new Date().toISOString() };
    if (w) Object.assign(patch, { whois_registrar: w.registrar, domain_created: w.created, domain_expiry: w.expiry, domain_age_days: w.ageDays, expiring_soon: w.expiringSoon });
    await client.request(updateItem('sites', job.siteId, patch)).catch(() => {});
    if (w && !SKIP_DH_SCORE) await pub(SUBJECTS.score, { domain: job.domain, siteId: job.siteId }, `score:${job.domain}`);
    return 'ack';
  }

  // ---- SUBDOMÍNIOS (crt.sh) — sharded entre workers (Fase C: exit nodes) ------
  async function handleSubdomains(job) {
    const { discoverSubdomains } = await import('../lib/subdomains.js');
    const site = await siteRow(job.siteId || 0, ['id', 'domain', 'hostnames'])
      || (job.domain ? (await client.request(readItems('sites', { filter: { domain: { _eq: job.domain } }, fields: ['id', 'domain', 'hostnames'], limit: 1 })))[0] : null);
    if (!site) return 'ack';
    if (site.hostnames && !job.force) return 'ack'; // resume
    // Multi-fonte (certspotter + crt.sh + securitytrails/censys/subfinder). Todas as fontes falharem
    // (unavailable) → lança → nak/retry. Substitui o crt.sh-PG único, que era um SPOF instável.
    const { names } = await discoverSubdomains(site.domain);
    const subs = names.filter((h) => h !== site.domain && !h.startsWith('www.'));
    await client.request(updateItem('sites', site.id, { hostnames: subs }));
    return 'ack';
  }

  // ---- CAMPANHAS (Fase F): gera cópia por IA + envia ------------------------
  const EMAIL_GEN_FIELDS = ['id', 'status', 'token', 'campaign.angle', 'campaign.from_name', 'campaign.from_email', 'campaign.subject_hint',
    'contact.name', 'contact.email', 'site.domain', 'site.business_city', 'site.industry', 'site.load_bucket', 'site.seo_score',
    'site.security_findings', 'site.cms_version', 'site.cms_outdated', 'site.spf_status', 'site.dmarc_status', 'site.gmb',
    'site.ssl_days_left', 'site.expiring_soon', 'site.dns_provider', 'site.primary_platform.slug', 'site.company.name'];
  async function handleCampaignGenerate(job) {
    if (!job?.emailId) return 'term';
    const rows = await client.request(readItems('emails', { filter: { id: { _eq: job.emailId } }, fields: EMAIL_GEN_FIELDS, limit: 1 }));
    const em = rows[0]; if (!em) return 'ack';
    const site = em.site || {}; const company = site.company || {};
    const gen = await generateEmail({ contact: em.contact, site, company, campaign: em.campaign || {}, angle: em.campaign?.angle });
    await client.request(updateItem('emails', em.id, { subject: clip(gen.subject, 255), body: gen.body, variables: gen.variables, ai_generated: gen.ai_generated, status: 'ready', error: null }));
    return 'ack';
  }
  async function handleCampaignSend(job) {
    if (!job?.emailId) return 'term';
    const rows = await client.request(readItems('emails', { filter: { id: { _eq: job.emailId } }, fields: ['id', 'to_email', 'to_name', 'subject', 'body', 'token', 'status', 'contact.do_not_contact', 'campaign.id', 'campaign.angle', 'campaign.from_name', 'campaign.from_email', 'campaign.reply_to', 'site.id', 'site.domain'], limit: 1 }));
    const em = rows[0]; if (!em) return 'ack';
    if (['sent', 'opened', 'clicked', 'replied'].includes(em.status)) return 'ack'; // idempotente: já enviado
    // Supressão (Outreach Fase 2): nunca enviar a contactos em DNC.
    if (em.contact?.do_not_contact) { await client.request(updateItem('emails', em.id, { status: 'skipped', error: 'DNC' })); return 'ack'; }
    if (!em.to_email || !em.subject || !em.body) { await client.request(updateItem('emails', em.id, { status: 'failed', error: 'sem to_email/subject/body' })); return 'ack'; }
    const res = await sendEmail({ to: em.to_email, toName: em.to_name, from: em.campaign?.from_email, fromName: em.campaign?.from_name, replyTo: em.campaign?.reply_to, subject: em.subject, body: em.body, token: em.token });
    if (res.ok) {
      await client.request(updateItem('emails', em.id, { status: 'sent', sent_at: new Date().toISOString(), error: res.dryRun ? 'dry-run (SMTP não configurado)' : null }));
      await capture('np_email_sent', em.site?.domain || em.to_email, { campaign_id: em.campaign?.id, angle: em.campaign?.angle, domain: em.site?.domain, dry_run: !!res.dryRun });
    } else {
      await client.request(updateItem('emails', em.id, { status: 'failed', error: clip(res.error, 255) }));
    }
    return 'ack';
  }

  // ---- DISCOVER (TLD-as-job): colhe um bloco CC → publica jobs.fetch por domínio
  async function handleDiscover(job) {
    if (!job?.crawlId || !job?.block) return 'term';
    const { harvestBlockDomains } = await import('../tld-domains-v2.js');
    const domains = await harvestBlockDomains(job.crawlId, job.block, job.tld || 'pt');
    for (const d of domains) await pub(SUBJECTS.fetch, { domain: d }, `fetch:${d}`);
    return 'ack';
  }

  // ---- VERIFY (Fase A): valida os emails de um domínio via o pool de APIs free ----
  // Job = { domain } (o org_domain da empresa). Corre em VMs remotas (WORKER_ROLES=verify)
  // usando as chaves free LOCAIS a cada IP. Reutiliza lib/verify-core.js (mesma lógica
  // que verify-emails.js). Sem quota → verifyDomain LANÇA → nak (volta à fila mais tarde).
  async function handleVerify(job) {
    const domain = job?.domain;
    if (!domain) return 'term';
    const { providers, reacher, mxCache } = await verifyPool();
    if (!providers.count && !reacher.enabled()) return 'ack'; // sem verificador configurado → no-op
    const contacts = await client.request(readItems('contacts', {
      filter: { email_status: { _null: true }, company: { org_domain: { _eq: domain } } },
      fields: ['id', 'name', 'email'], limit: 500,
    }));
    if (!contacts.length) return 'ack';
    const counts = await verifyDomain(client, { domain, contacts }, { providers, reacher, mxCache, maxCand: VERIFY_MAX_CAND });
    const done = Object.values(counts).reduce((a, b) => a + b, 0);
    if (done) console.log(`${new Date().toISOString().slice(11, 19)} verify ${domain}: ${JSON.stringify(counts)}`);
    return 'ack';
  }

  return { handleFetch, handleDns, handleGeoip, handleFingerprint, handleSocial, handleLocality, handleEmailauth, handleTraffic, handleContacts, handleScore, handleSsl, handleSsllabs, handleDnsprovider, handleWhois, handleSubdomains, handleDiscover, handleVerify, handleCampaignGenerate, handleCampaignSend };
}
