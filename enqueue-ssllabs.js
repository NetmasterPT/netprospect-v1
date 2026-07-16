// enqueue-ssllabs.js
// Batch de análise SSL Labs para leads de TOPO. O SSL Labs é lento (~1-3 min/host) e rate-limited
// (~7 assessments/IP) → só faz sentido num conjunto pequeno. Por isso exige um scope explícito
// (--qualified ou --min-score); recusa correr sobre a base toda.
//
//   node enqueue-ssllabs.js --qualified              # todos os qualificados
//   node enqueue-ssllabs.js --min-score=60           # lead_score >= 60
//   node enqueue-ssllabs.js --min-score=60 --fresh   # força re-análise (ignora cache <24h)
//   node enqueue-ssllabs.js --min-score=60 --limit=200
//
// Resume: salta os que já têm ssllabs_grade (--force reprocessa). O cap do consumer (4) trava a taxa.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const QUALIFIED = argv.includes('--qualified');
const FORCE = argv.includes('--force');
const FRESH = argv.includes('--fresh');
const PAGE = 500;

if (!QUALIFIED && MIN_SCORE == null) {
  console.error('Scope obrigatório: usa --qualified ou --min-score=N (o SSL Labs é lento/rate-limited, não corre na base toda).');
  process.exit(1);
}

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  const base = { is_live: { _eq: true }, ssl_grade: { _nnull: true } };
  if (QUALIFIED) base.qualified = { _eq: true };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  if (!FORCE) base.ssllabs_grade = { _null: true };
  console.log(`SSL Labs batch${QUALIFIED ? ' | qualificados' : ''}${MIN_SCORE != null ? ` | score >= ${MIN_SCORE}` : ''}${FRESH ? ' | fresh' : ' | cache<24h'}${FORCE ? ' | force' : ' | resume'}${LIMIT ? ` | limite ${LIMIT}` : ''}`);

  let lastId = 0, n = 0;
  for (;;) {
    if (LIMIT && n >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - n) : PAGE;
    const rows = await client.request(readItems('sites', {
      filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain'], sort: ['id'], limit: pageSize,
    }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) {
      await publishJob(js, SUBJECTS.ssllabs, { domain: s.domain, siteId: s.id, fresh: FRESH }, { msgId: `ssllabs:${s.domain}` });
      n++;
    }
    console.log(`  ${n} jobs`);
  }
  console.log(`Concluído. ${n} jobs SSL Labs publicados (cap do consumer trava a taxa).`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
