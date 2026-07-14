// worker/worker.mjs
// Worker replicável da pipeline NetProspect. Liga-se ao NATS JetStream, garante
// a topologia (stream + consumers) e consome os jobs, despachando por subject:
//   jobs.enrich   -> enriquecer domínio (DNS/IP/geo/tech/liveness + auditoria barata)
//   jobs.contacts -> extrair contactos-pessoa do site
//   jobs.audit.*  -> auditoria pesada (Lighthouse/Nuclei/Tranco/Ollama/GMB/WPScan)
//
// Encadeamento (DAG pela própria fila): enrich concluído -> se qualificado publica
// jobs.contacts (+ jobs.audit.qualified quando AUDIT_ENABLED); senão jobs.audit.rest.
// Auditoria: drain por PRIORIDADE ondemand -> qualified -> rest (o "Auditar agora"
// salta à frente do batch). WPScan só em jobs on-demand + WordPress.
//
// Escala: `docker compose up -d --scale worker=N`. Concorrência interna por env.

import { readItems, createItem } from '@directus/sdk';
// updateItem shadow → escrita direta no PG p/ sites/companies com DIRECT_PG_WRITE on (A2).
import { updateItemMaybePg as updateItem, wrapClientPg, pgFlushSites } from '../lib/pgwrite.js';
import {
  connectJobs, ensureStream, ensureConsumer, publishJob, decodeJob, isTransientJobErr,
  STREAM, SUBJECTS, CONSUMERS, consumersForRoles,
} from '../lib/jobs.js';
import { createEnrichContext, enrichOne, upsertSite } from '../enrich-sites.js';
import { processSite } from '../extract-contacts.js';
import { makeFineHandlers } from './handlers.mjs';
import { getSnapshot, ensureBucket, ensureReportsBucket, putReport } from '../lib/artifacts.js';
import { initEgress, egressDispatcher } from '../lib/egress.js';
import { makeClient } from '../lib/directus.js';
import { startTelemetry, taskStart, taskEnd, logLine } from '../lib/worker-telemetry.js';
import { classifyIndustryHeuristic } from '../lib/audit/industry-heuristic.js';

const WORKER_ROLES = process.env.WORKER_ROLES || ''; // vazio=todos; ex.: base|browser|security|ai|verify

const ENRICH_CONC = Math.max(1, parseInt(process.env.ENRICH_CONCURRENCY || '10', 10));
const CONTACTS_CONC = Math.max(1, parseInt(process.env.CONTACTS_CONCURRENCY || '5', 10));
// Concorrência dos jobs de saúde de domínio (ssl/dnsprovider/whois). Baixar via
// DOMAIN_HEALTH_CONC=N quando o backfill tem de escorrer sem saturar o CPU (partilha
// a máquina com os streams de enrich). Default preserva o comportamento normal.
const DH_CONC = Math.max(1, parseInt(process.env.DOMAIN_HEALTH_CONC || '8', 10));
// O fingerprint (re-fetch + parse da homepage com wappalyzer) é CPU-PESADO — concorrência
// PRÓPRIA (não partilha o DH_CONC nem o antigo hardcode 8) para poder correr o backfill de
// cms a ritmo baixo sem saturar o CPU: N_workers × FINGERPRINT_CONC parses concorrentes.
const FINGERPRINT_CONC = Math.max(1, parseInt(process.env.FINGERPRINT_CONC || '4', 10));
// Cada job ssl/whois/dnsprovider publica um `score` (recalcula qualify+lead-score →
// leitura+escrita Directus + escrita ClickHouse). Num backfill grande essa cascata é
// que satura o Directus. Baixar SCORE_CONC estrangula a amplificação.
const SCORE_CONC = Math.max(1, parseInt(process.env.SCORE_CONC || '12', 10));
// Concorrência dos jobs de verificação de email (worker verify remoto). Baixa por
// omissão porque cada job consome quota free (APIs limitadas). Subir só se houver
// muitas chaves/IPs. VERIFY_CONCURRENCY.
const VERIFY_CONC = Math.max(1, parseInt(process.env.VERIFY_CONCURRENCY || '4', 10));
// Auditorias pesadas (Lighthouse/Chromium + Nuclei + Ollama) processadas em paralelo POR worker.
// Default 1 = comportamento antigo (serial). Subir só se houver CPU — cada uma é ~1-2 cores.
const AUDIT_CONC = Math.max(1, parseInt(process.env.AUDIT_CONC || '1', 10));
// Concorrência dos jobs FINOS pesados. Sem isto caíam no default do mapa CONC (=1) e cada
// worker fazia UM de cada vez — o que estrangulava a pipeline repartida. Cada um tem um
// perfil MUITO diferente (medido):
//   nuclei     → NETWORK-bound (espera em HTTP; o DE1 ficava a 0.02 de load!) → pode ir alto
//   lighthouse → CPU-bound (Chromium) → moderado
//   industry   → OLLAMA-bound: o llama.cpp é capado (OLLAMA_CPUS); pôr N classificações a
//                competir pelos mesmos cores fazia cada uma passar do ackWait de 180s →
//                timeout → redelivery infinita. TEM de ficar baixo.
const NUCLEI_JOB_CONC = Math.max(1, parseInt(process.env.NUCLEI_JOB_CONC || '6', 10));
const LIGHTHOUSE_CONC = Math.max(1, parseInt(process.env.LIGHTHOUSE_CONC || '2', 10));
const INDUSTRY_CONC = Math.max(1, parseInt(process.env.INDUSTRY_CONC || '1', 10));
// GMB corre no portátil (IP residencial); conc baixa por defeito p/ não afogar o daily-driver.
const GMB_CONC = Math.max(1, parseInt(process.env.GMB_CONC || '2', 10));
const WPSCAN_CONC = Math.max(1, parseInt(process.env.WPSCAN_CONC || '2', 10));
const AUDIT_ENABLED = /^(1|true|yes)$/i.test(process.env.AUDIT_ENABLED || '');
const GMB_ENABLED = /^(1|true|yes)$/i.test(process.env.GMB_ENABLED || '');
// industry: heurístico por default (instantâneo, sem GPU). INDUSTRY_LLM=true volta ao Ollama.
const INDUSTRY_LLM = /^(1|true|yes)$/i.test(process.env.INDUSTRY_LLM || '');
const WID = process.env.HOSTNAME || String(process.pid);
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} [w:${WID}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (v, n = 255) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);

const UA = 'netprospect-audit/1.0 (+https://netmaster.pt; prospecao B2B)';
async function fetchHomepage(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, dispatcher: egressDispatcher(), headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html|xml|^$/.test(ct)) { try { await r.body?.cancel(); } catch { /* ignora */ } return null; }
    return { url: r.url, html: (await r.text()).slice(0, 1_500_000) };
  } catch { return null; }
  finally { clearTimeout(to); }
}

// Upsert idempotente de site_reports por (site, kind).
async function upsertReport(client, siteId, kind, { score = null, summary = null, report = null }) {
  const found = await client.request(readItems('site_reports', { filter: { site: { _eq: siteId }, kind: { _eq: kind } }, fields: ['id'], limit: 1 }));
  const payload = { site: siteId, kind, score, summary, report };
  if (found.length) await client.request(updateItem('site_reports', found[0].id, payload));
  else await client.request(createItem('site_reports', payload));
}

// Carrega os módulos pesados só quando as auditorias estão ligadas.
async function createAuditContext() {
  const [tranco, ollama, nuclei, lh, gmb, wpscan] = await Promise.all([
    import('../lib/audit/tranco.js'), import('../lib/audit/ollama-classify.js'), import('../lib/audit/nuclei.js'),
    import('../lib/audit/lighthouse.js'), import('../lib/audit/gmb-lookup.js'), import('../lib/audit/wpscan.js'),
  ]);
  try { tranco.loadTranco(); } catch { /* CSV em falta -> unranked */ }
  // Pré-aquece o Ollama sem bloquear (carrega o modelo p/ RAM em segundo plano).
  ollama.warmup().then((ok) => log(`ollama warmup: ${ok ? 'modelo carregado' : 'falhou/tarde'}`)).catch(() => {});
  return { tranco, ollama, nuclei, lh, gmb, wpscan };
}

// Handlers FINOS pesados (um por ferramenta) — reutilizam os módulos de auditoria.
// Cada job é uma só ferramenta; recomputa o score no fim. (job) -> outcome.
function makeHeavyFineHandlers(ctx, audit, js) {
  const client = wrapClientPg(ctx.client, js);
  const rescore = (job) => publishJob(js, SUBJECTS.score, { domain: job.domain, siteId: job.siteId });
  const load = async (job, fields) => (await client.request(readItems('sites', { filter: job.siteId ? { id: { _eq: job.siteId } } : { domain: { _eq: job.domain } }, fields: ['id', 'domain', 'final_url', ...fields], limit: 1 })))[0];

  async function industry(job) {
    const site = await load(job, []); if (!site) return 'ack';
    const snap = await getSnapshot(site.id);
    let html = snap?.html;
    if (!html) { const h = await fetchHomepage(site.final_url || `https://${site.domain}/`); html = h?.html; }
    if (!html) return 'ack';
    // Classificador HEURÍSTICO (keywords) por default — instantâneo, sem GPU. O Ollama em CPU
    // levava 107 s/site (26 dias p/ 729k) e roubava CPU ao Lighthouse. INDUSTRY_LLM=true volta
    // ao Ollama (só faz sentido numa VM com GPU).
    try {
      const s = audit.ollama.summarizeForClassify(html, {});
      const cls = INDUSTRY_LLM ? await audit.ollama.classifyIndustry(s) : classifyIndustryHeuristic(s);
      if (cls.industry) await client.request(updateItem('sites', site.id, { industry: cls.industry, industry_confidence: cls.confidence }));
    } catch (e) { log(`industry ${site.domain}: ${e.message}`); }
    return 'ack';
  }
  async function lighthouse(job, kind) {
    const site = await load(job, []); if (!site) return 'ack';
    const url = site.final_url || `https://${site.domain}/`;
    try {
      const r = await audit.lh.runLighthouse(url);
      await client.request(updateItem('sites', site.id, { seo_score: r.seo_score, mobile_score: r.mobile_score, mobile_friendly: r.mobile_friendly }));
      // Postgres = resumo (rápido p/ o dashboard); MinIO = relatório INTEGRAL sem screenshots
      // (71 KB gzip vs 396 KB com imagens) — é dele que sai o PDF/relatório do cliente.
      const _full = await putReport(site.id, kind, audit.lh.leanLhr(r.lhr));
      await upsertReport(client, site.id, kind, { score: r.seo_score, summary: audit.lh.lighthouseSummary(r), report: { ...audit.lh.trimLhr(r.lhr), _full } });
      await rescore({ domain: site.domain, siteId: site.id });
    } catch (e) { log(`lighthouse ${site.domain}: ${e.message}`); }
    return 'ack';
  }
  async function nuclei(job) {
    const site = await load(job, []); if (!site) return 'ack';
    try {
      const r = await audit.nuclei.runNuclei(site.final_url || `https://${site.domain}/`);
      await client.request(updateItem('sites', site.id, { security_findings: r.findings, security_severity: r.severity }));
      await upsertReport(client, site.id, 'nuclei', { score: r.findings, summary: { findings: r.findings, severity: r.severity, bySeverity: r.bySeverity }, report: { _full: await putReport(site.id, "nuclei", { results: r.results }) } });
      await rescore({ domain: site.domain, siteId: site.id });
    } catch (e) { log(`nuclei ${site.domain}: ${e.message}`); }
    return 'ack';
  }
  async function wpscan(job) {
    const site = await load(job, ['primary_platform.slug']); if (!site) return 'ack';
    // WooCommerce É WordPress (plugin do WP) → o wpscan aplica-se aos dois.
    if (!['wordpress', 'woocommerce'].includes(site.primary_platform?.slug || '')) return 'ack';
    try {
      // Batch keyless (job.keyless) → SEM --api-token: enumera (plugins/temas/versão/users) mas
      // não traz o vuln-DB do WPScan (poupa a quota de 25/dia/key, que fica só p/ on-demand).
      // On-demand keyed → usa a WPSCAN_API_TOKEN do host (uma key por host).
      const token = job.keyless ? null : process.env.WPSCAN_API_TOKEN;
      const r = await audit.wpscan.runWpscan(site.final_url || `https://${site.domain}/`, { token });
      await client.request(updateItem('sites', site.id, { wp_vuln_count: r.vulnCount }));
      await upsertReport(client, site.id, 'wpscan', { score: r.vulnCount, summary: { vulnCount: r.vulnCount }, report: r.report });
    } catch (e) { log(`wpscan ${site.domain}: ${e.message}`); }
    return 'ack';
  }
  async function gmb(job) {
    if (!GMB_ENABLED) return 'ack';
    const site = await load(job, ['business_city', 'company.name']); if (!site) return 'ack';
    try {
      const g = await audit.gmb.lookupGmb({ name: site.company?.name, city: site.business_city, domain: site.domain });
      if (g && g.name) {
        await client.request(updateItem('sites', site.id, { gmb: true, gmb_name: clip(g.name), gmb_category: clip(g.category, 120), gmb_rating: g.rating, gmb_reviews: g.reviews, gmb_phone: clip(g.phone, 60), gmb_url: clip(g.url), business_city: g.city ? clip(g.city, 120) : undefined, business_region: g.region ? clip(g.region, 120) : undefined, business_address: g.address ? clip(g.address) : undefined }));
        await upsertReport(client, site.id, 'gmb', { summary: g, report: g });
      }
    } catch (e) { log(`gmb ${site.domain}: ${e.message}`); }
    return 'ack';
  }
  return {
    industry,
    lighthouse_mobile: (j) => lighthouse(j, 'lighthouse_seo'),
    lighthouse_desktop: (j) => lighthouse(j, 'lighthouse_mobile'),
    nuclei, wpscan, gmb,
  };
}

// --- Handlers ---------------------------------------------------------------
function makeHandlers(ctx, audit, js) {
  const client = wrapClientPg(ctx.client, js);

  async function handleEnrich(job) {
    if (!job?.domain) return 'term';
    const rec = await enrichOne(job.domain, ctx);
    const siteId = await upsertSite(client, rec, ctx.platformIdBySlug, ctx.knownDomains);
    if (rec.qualified) await publishJob(js, SUBJECTS.contacts, { domain: rec.domain, siteId }, { msgId: `contacts:${rec.domain}` });
    if (AUDIT_ENABLED) {
      const subj = rec.qualified ? SUBJECTS.auditQualified : SUBJECTS.auditRest;
      await publishJob(js, subj, { domain: rec.domain, siteId }, { msgId: `audit:${rec.domain}` });
    }
    return 'ack';
  }

  async function handleContacts(job) {
    if (!job?.domain && !job?.siteId) return 'term';
    const filter = job.siteId ? { id: { _eq: job.siteId } } : { domain: { _eq: job.domain } };
    const rows = await client.request(readItems('sites', { filter, fields: ['id', 'domain', 'final_url', 'company', 'contacts_checked_at'], limit: 1 }));
    const site = rows[0];
    if (!site || !site.company) return 'ack';
    if (site.contacts_checked_at && !job.force) return 'ack';
    const created = await processSite(client, site);
    if (created) log(`contactos ${site.domain}: +${created}`);
    return 'ack';
  }

  // Auditoria pesada. `m` = mensagem NATS (p/ working()); `tier` = ondemand|qualified|rest.
  async function handleAudit(m, tier) {
    const job = decodeJob(m);
    if (!job?.domain && !job?.siteId) { m.term(); return; }
    const filter = job.siteId ? { id: { _eq: job.siteId } } : { domain: { _eq: job.domain } };
    const rows = await client.request(readItems('sites', { filter, fields: ['id', 'domain', 'final_url', 'business_city', 'primary_platform.slug', 'company.name'], limit: 1 }));
    const site = rows[0];
    if (!site) { m.term(); return; }
    const bizName = site.company?.name || null;
    const url = site.final_url || `https://${site.domain}/`;
    // job.only = subconjunto de passos a correr (ex.: ['wpscan'] do botão WPScan);
    // ausente = todos. want(step) decide cada passo.
    const only = Array.isArray(job.only) && job.only.length ? new Set(job.only) : null;
    const want = (step) => !only || only.has(step);
    const patch = { audit_checked_at: new Date().toISOString() };
    try {
      await client.request(updateItem('sites', site.id, { audit_status: 'running' }));

      // Tranco (rápido, local).
      if (want('tranco')) { try { const tr = audit.tranco.trafficOf(site.domain); patch.traffic_rank = tr.rank; patch.traffic_bucket = tr.bucket; } catch { /* ignora */ } }

      // Homepage + classificação de atividade (Ollama).
      if (want('industry')) {
        m.working();
        const home = await fetchHomepage(url);
        if (home?.html) {
          try {
            const s = audit.ollama.summarizeForClassify(home.html, { title: bizName });
            const cls = await audit.ollama.classifyIndustry(s);
            if (cls.industry) { patch.industry = cls.industry; patch.industry_confidence = cls.confidence; }
          } catch (e) { log(`ollama ${site.domain}: ${e.message}`); }
        }
      }

      // Lighthouse (SEO + mobile).
      if (want('lighthouse')) {
        m.working();
        try {
          const r = await audit.lh.runLighthouse(url);
          patch.seo_score = r.seo_score; patch.mobile_score = r.mobile_score; patch.mobile_friendly = r.mobile_friendly;
          const _full = await putReport(site.id, 'lighthouse_seo', audit.lh.leanLhr(r.lhr));
          await upsertReport(client, site.id, 'lighthouse_seo', { score: r.seo_score, summary: audit.lh.lighthouseSummary(r), report: { ...audit.lh.trimLhr(r.lhr), _full } });
        } catch (e) { log(`lighthouse ${site.domain}: ${e.message}`); }
      }

      // Nuclei (segurança, batch).
      if (want('nuclei')) {
        m.working();
        try {
          const r = await audit.nuclei.runNuclei(url);
          patch.security_findings = r.findings; patch.security_severity = r.severity;
          await upsertReport(client, site.id, 'nuclei', { score: r.findings, summary: { findings: r.findings, severity: r.severity, bySeverity: r.bySeverity }, report: { _full: await putReport(site.id, "nuclei", { results: r.results }) } });
        } catch (e) { log(`nuclei ${site.domain}: ${e.message}`); }
      }

      // GMB via browser — só on-demand + opt-in (GMB_ENABLED). Frágil/lento e o
      // Google bloqueia IPs de datacenter; por omissão fica desligado no batch.
      if (want('gmb') && GMB_ENABLED && tier === 'ondemand') {
      m.working();
      try {
        const g = await audit.gmb.lookupGmb({ name: bizName, city: site.business_city, domain: site.domain });
        if (g && g.name) {
          patch.gmb = true; patch.gmb_name = clip(g.name); patch.gmb_category = clip(g.category, 120);
          patch.gmb_rating = g.rating; patch.gmb_reviews = g.reviews; patch.gmb_phone = clip(g.phone, 60);
          patch.gmb_url = clip(g.url); patch.gmb_place_id = clip(g.placeId);
          if (g.city) patch.business_city = clip(g.city, 120);
          if (g.region) patch.business_region = clip(g.region, 120);
          if (g.address) patch.business_address = clip(g.address);
          await upsertReport(client, site.id, 'gmb', { summary: g, report: g });
        }
      } catch (e) { log(`gmb ${site.domain}: ${e.message}`); }
      }

      // WPScan — SÓ on-demand + WordPress (25/dia).
      if (want('wpscan') && tier === 'ondemand' && site.primary_platform?.slug === 'wordpress') {
        m.working();
        try {
          const r = await audit.wpscan.runWpscan(url);
          patch.wp_vuln_count = r.vulnCount;
          await upsertReport(client, site.id, 'wpscan', { score: r.vulnCount, summary: { vulnCount: r.vulnCount }, report: r.report });
        } catch (e) { log(`wpscan ${site.domain}: ${e.message}`); }
      }

      patch.audit_status = 'done';
      await client.request(updateItem('sites', site.id, patch));
      log(`audit ${tier} ${site.domain}: seo=${patch.seo_score ?? '-'} mob=${patch.mobile_score ?? '-'} sec=${patch.security_findings ?? '-'} ind=${patch.industry ?? '-'}`);
      m.ack();
    } catch (e) {
      const msg = e?.errors ? JSON.stringify(e.errors) : (e?.message || String(e));
      patch.audit_status = 'error'; patch.audit_error = clip(msg, 500);
      try { await client.request(updateItem('sites', site.id, patch)); } catch { /* ignora */ }
      if (isTransientJobErr(e)) { m.nak(); log(`↻ audit ${site.domain}: ${msg}`); }
      else { m.term(); log(`✗ audit ${site.domain}: ${msg}`); }
    }
  }

  return { handleEnrich, handleContacts, handleAudit };
}

// --- Loops de consumo -------------------------------------------------------
// enrich/contacts: consumo contínuo com concorrência limitada.
async function consumeLoop(js, durable, concurrency, fn) {
  const consumer = await js.consumers.get(STREAM, durable);
  const messages = await consumer.consume({ max_messages: concurrency });
  const inflight = new Set();
  log(`consumer '${durable}' a consumir (conc ${concurrency})`);
  for await (const m of messages) {
    const p = (async () => {
      const job = decodeJob(m);
      const label = job?.domain || job?.emailId || job?.ip || durable;
      const started = Date.now();
      taskStart(durable, `${durable} · ${label}`); // fire-and-forget (fail-soft)
      try {
        const outcome = await fn(job);
        if (outcome === 'term') { m.term(); taskEnd(durable, started, false); return; }
        m.ack(); taskEnd(durable, started, true); logLine(`✓ ${durable} ${label} (${Date.now() - started}ms)`);
      } catch (e) {
        const msg = e?.errors ? JSON.stringify(e.errors) : (e?.message || String(e));
        taskEnd(durable, started, false);
        if (isTransientJobErr(e)) { m.nak(); log(`↻ ${durable} ${job?.domain}: ${msg}`); logLine(`↻ ${durable} ${label}: ${msg}`); }
        else { m.term(); log(`✗ ${durable} ${job?.domain}: ${msg}`); logLine(`✗ ${durable} ${label}: ${msg}`); }
      }
    })().finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= concurrency) await Promise.race(inflight);
  }
}

// audit: drain por PRIORIDADE (ondemand > qualified > rest), 1 de cada vez
// (Lighthouse é pesado). O ondemand salta à frente do batch.
async function auditDrainLoop(js, run) {
  const cons = {};
  for (const t of ['ondemand', 'qualified', 'rest']) cons[t] = await js.consumers.get(STREAM, CONSUMERS['audit_' + t].durable);
  // Antes fazia `await run(m)` → 1 auditoria DE CADA VEZ por worker (o maxAckPending nem chegava
  // a ser o limite). AUDIT_CONC processa N em paralelo por worker; a prioridade dos tiers mantém-se.
  const inflight = new Set();
  log(`audit drain a correr (prioridade ondemand > qualified > rest, conc ${AUDIT_CONC})`);
  for (;;) {
    if (inflight.size >= AUDIT_CONC) { await Promise.race(inflight); continue; }
    let did = false;
    for (const t of ['ondemand', 'qualified', 'rest']) {
      // nats.js exige expires>=1000ms. Tiers altos curtos p/ varrer depressa; rest longo.
      const msgs = await cons[t].fetch({ max_messages: 1, expires: t === 'rest' ? 4000 : 1000 });
      for await (const m of msgs) {
        did = true;
        const p = Promise.resolve(run(m, t)).catch(() => {}).finally(() => inflight.delete(p));
        inflight.add(p);
      }
      if (did) break; // recomeça do topo (ondemand) após cada job
    }
    if (!did) await sleep(300);
  }
}

// A3 write-behind — pool de writers: puxa lotes de jobs.result.site, COALESCE por id
// (N patches do mesmo site → 1), faz 1 UPDATE (pgFlushSites) e faz ack do lote todo.
// Falha → nak do lote (redelivery → re-UPDATE idempotente). Corre perto do Postgres.
async function writerLoop(js) {
  const consumer = await js.consumers.get(STREAM, CONSUMERS.result_site.durable);
  const BATCH = Math.max(50, parseInt(process.env.WRITER_BATCH || '500', 10));
  log(`writer 'result_site' a correr (batch ${BATCH})`);
  for (;;) {
    const msgs = await consumer.fetch({ max_messages: BATCH, expires: 1000 });
    const buf = []; const byId = new Map();
    for await (const m of msgs) {
      buf.push(m);
      const job = decodeJob(m);
      if (job && job.id != null) { const prev = byId.get(job.id); if (prev) Object.assign(prev, job.patch); else byId.set(job.id, { ...job.patch }); }
    }
    if (!buf.length) continue;
    const started = Date.now();
    taskStart('result_site', `flush ${byId.size} sites (${buf.length} msgs)`);
    try {
      await pgFlushSites([...byId.entries()].map(([id, patch]) => ({ id, patch })));
      for (const m of buf) m.ack();
      taskEnd('result_site', started, true);
      logLine(`✓ flush ${byId.size} sites (${buf.length} msgs, ${Date.now() - started}ms)`);
    } catch (e) {
      for (const m of buf) m.nak();
      taskEnd('result_site', started, false);
      const msg = e?.message || String(e);
      log(`✗ writer flush: ${msg}`); logLine(`✗ writer flush: ${msg}`);
    }
  }
}

// Consumers "leves" (base) que correm sempre; os pesados (browser/security/ai)
// só quando AUDIT_ENABLED (custam CPU/Chromium).
const HEAVY = new Set(['industry', 'lighthouse_mobile', 'lighthouse_desktop', 'nuclei', 'wpscan', 'gmb', 'audit_ondemand', 'audit_qualified', 'audit_rest']);
const DRAIN = new Set(['audit_ondemand', 'audit_qualified', 'audit_rest']);
// Concorrência por consumer (heavy = 1; leves = mais).
const CONC = { enrich: ENRICH_CONC, contacts: CONTACTS_CONC, fetch: 8, dns: 12, geoip: 12, fingerprint: FINGERPRINT_CONC, social: 8, locality: 8, emailauth: 10, traffic: 20, score: SCORE_CONC, ssl: DH_CONC, whois: Math.max(1, Math.ceil(DH_CONC / 2)), dnsprovider: DH_CONC, subdomains: 2, verify: VERIFY_CONC, discover: 2, campaign_generate: 4, campaign_send: 6,
  // finos pesados (ver comentário no topo): nuclei é network-bound, industry é Ollama-bound.
  nuclei: NUCLEI_JOB_CONC, wpscan: WPSCAN_CONC, lighthouse_mobile: LIGHTHOUSE_CONC, lighthouse_desktop: LIGHTHOUSE_CONC,
  industry: INDUSTRY_CONC, gmb: GMB_CONC };

// --- Arranque ---------------------------------------------------------------
async function main() {
  log(`a arrancar (roles=${WORKER_ROLES || 'todos'}, audit=${AUDIT_ENABLED ? 'on' : 'off'})`);
  await initEgress(); // egresso externo via EGRESS_PROXY (exit node), se definido
  const nc = await connectJobs();
  log(`ligado ao NATS: ${nc.getServer()}`);
  const jsm = await ensureStream(nc);

  // Consumers ativos = os do(s) role(s) deste worker; pesados só se AUDIT_ENABLED.
  const active = consumersForRoles(WORKER_ROLES).filter((name) => AUDIT_ENABLED || !HEAVY.has(name));
  for (const name of active) await ensureConsumer(jsm, CONSUMERS[name]);
  await startTelemetry({ roles: WORKER_ROLES || 'todos', consumers: active.join(',') }); // heartbeat + métricas (Redis, fail-soft)

  // Contexto pesado (wappalyzer + geoip + domínios conhecidos) só se algum consumer
  // ativo o exige (enrich/contacts/fetch/fingerprint/…). Um worker SÓ-verify (VM free
  // pequena de 1 GB) arranca com contexto MÍNIMO — poupa RAM e tempo de arranque.
  const HEAVY_CTX = new Set(['enrich', 'contacts', 'fetch', 'fingerprint', 'geoip', 'dns', 'discover', 'social', 'locality', 'industry']);
  const ctx = active.some((n) => HEAVY_CTX.has(n))
    ? await createEnrichContext({ wappalyzer: true, loadKnownDomains: true })
    : { client: makeClient(), geoip: { mode: 'off', lookup: async () => ({}) }, platformIdBySlug: {}, knownDomains: new Set() };
  log(`contexto pronto: geoip=${ctx.geoip.mode}, plataformas=${Object.keys(ctx.platformIdBySlug).length}, domínios conhecidos=${ctx.knownDomains.size}`);
  const needAudit = active.some((n) => HEAVY.has(n));
  const audit = needAudit ? await createAuditContext() : null;
  if (audit) ctx.audit = audit; // p/ o handler traffic dos fine handlers
  // Buckets: snapshots (páginas) + reports (relatórios integrais de auditoria).
  try { await ensureBucket(); await ensureReportsBucket(); } catch (e) { log(`MinIO indisponível: ${e.message}`); }
  const js = nc.jetstream();

  const coarse = makeHandlers(ctx, audit, js);
  const fine = makeFineHandlers(ctx, js);
  const heavy = audit ? makeHeavyFineHandlers(ctx, audit, js) : {};

  // Registo: nome do consumer -> handler (job)->outcome.
  const REG = {
    enrich: coarse.handleEnrich, contacts: fine.handleContacts, verify: fine.handleVerify,
    fetch: fine.handleFetch, dns: fine.handleDns, geoip: fine.handleGeoip, fingerprint: fine.handleFingerprint,
    social: fine.handleSocial, locality: fine.handleLocality, emailauth: fine.handleEmailauth, traffic: fine.handleTraffic,
    score: fine.handleScore, ssl: fine.handleSsl, whois: fine.handleWhois, dnsprovider: fine.handleDnsprovider,
    subdomains: fine.handleSubdomains, discover: fine.handleDiscover,
    campaign_generate: fine.handleCampaignGenerate, campaign_send: fine.handleCampaignSend,
    industry: heavy.industry, lighthouse_mobile: heavy.lighthouse_mobile, lighthouse_desktop: heavy.lighthouse_desktop,
    nuclei: heavy.nuclei, wpscan: heavy.wpscan, gmb: heavy.gmb,
  };

  const loops = [];
  const drainActive = active.filter((n) => DRAIN.has(n));
  for (const name of active) {
    if (DRAIN.has(name)) continue; // tratados pelo auditDrainLoop (coarse monolítico)
    const fn = REG[name]; if (!fn) continue;
    loops.push(consumeLoop(js, CONSUMERS[name].durable, CONC[name] || 1, fn));
  }
  if (drainActive.length === 3) loops.push(auditDrainLoop(js, coarse.handleAudit));
  if (active.includes('result_site')) loops.push(writerLoop(js)); // A3 write-behind

  const shutdown = async () => { log('a encerrar…'); try { await nc.drain(); } catch { /* ignora */ } process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log(`consumers ativos: ${active.join(', ')}`);
  await Promise.all(loops);
}

main().catch((err) => { console.error('Erro fatal no worker:', err); process.exit(1); });
