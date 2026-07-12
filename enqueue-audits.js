// enqueue-audits.js
// Produtor das auditorias pesadas. Prioridade nos subjects:
//   --tier=qualified   -> jobs.audit.qualified  (sites qualified=true)
//   --tier=rest        -> jobs.audit.rest        (live, não qualificados)
//   --tier=all         -> ambos
//   --domain=x.pt      -> jobs.audit.ondemand    (um domínio, salta à frente)
// Idempotente (dedup msgId=`audit:<domínio>`), salta `audit_checked_at` (salvo
// --force). --requeue-stale reagenda os presos em `running` há >2h.
//
//   node enqueue-audits.js --tier=qualified --limit=100
//   node enqueue-audits.js --domain=netmaster.pt

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const TIER = flag('tier', 'qualified');
const DOMAIN = flag('domain', null);
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const FORCE = argv.includes('--force');
const REQUEUE_STALE = argv.includes('--requeue-stale');
// --min-score=N → audita SÓ os leads com lead_score >= N. As auditorias são caras (render de
// Chromium + Nuclei + Ollama): a 729k qualificados são semanas. Priorizar o topo é onde está o valor.
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const PAGE = 500;

function subjectForTier(t) {
  return t === 'rest' ? SUBJECTS.auditRest : t === 'ondemand' ? SUBJECTS.auditOndemand : SUBJECTS.auditQualified;
}

async function enqueueTier(client, js, tier) {
  const base = tier === 'rest' ? { qualified: { _eq: false }, is_live: { _eq: true } } : { qualified: { _eq: true } };
  if (!FORCE) base.audit_checked_at = { _null: true };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  const subject = subjectForTier(tier);
  let lastId = 0, n = 0;
  for (;;) {
    if (LIMIT && n >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - n) : PAGE;
    const rows = await client.request(readItems('sites', { filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain'], sort: ['id'], limit: pageSize }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) { await publishJob(js, subject, { domain: s.domain, siteId: s.id }, { msgId: `audit:${s.domain}` }); n++; }
    console.log(`  ${tier}: enfileirados ${n}`);
  }
  return n;
}

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  let total = 0;
  if (DOMAIN) {
    await publishJob(js, SUBJECTS.auditOndemand, { domain: DOMAIN }, { msgId: `audit:${DOMAIN}` });
    console.log(`On-demand enfileirado: ${DOMAIN}`);
    total = 1;
  } else if (REQUEUE_STALE) {
    const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const rows = await client.request(readItems('sites', { filter: { audit_status: { _eq: 'running' }, audit_checked_at: { _lt: cutoff } }, fields: ['id', 'domain', 'qualified'], limit: -1 }));
    for (const s of rows) { await publishJob(js, s.qualified ? SUBJECTS.auditQualified : SUBJECTS.auditRest, { domain: s.domain, siteId: s.id }, { msgId: `audit:${s.domain}:requeue` }); total++; }
    console.log(`Reagendados ${total} jobs presos em running.`);
  } else {
    const tiers = TIER === 'all' ? ['qualified', 'rest'] : [TIER];
    for (const t of tiers) total += await enqueueTier(client, js, t);
  }
  console.log(`Concluído. ${total} jobs de auditoria publicados.`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err); process.exit(1); });
