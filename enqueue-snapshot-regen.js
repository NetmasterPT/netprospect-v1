// enqueue-snapshot-regen.js
// Regenera os SNAPSHOTS (que foram podados do MinIO) e reclassifica SÓ a indústria, sem re-correr
// os extractors partidos (contacts/social/locality) nem o enrich extra. Publica `fetch` com
// { snapshotOnly:true } → handleFetch guarda o snapshot e faz fan-out só p/ industry.
//
//   node enqueue-snapshot-regen.js                 # todos os live (default)
//   node enqueue-snapshot-regen.js --min-score=40  # só lead_score >= 40
//   node enqueue-snapshot-regen.js --qualified     # só qualificados
//   node enqueue-snapshot-regen.js --limit=1000    # teste
//
// O `fetch` é role `base`. Custo: 1 fetch de homepage por site (as páginas de contacto são
// saltadas no snapshotOnly). O snapshot fica no MinIO e é reutilizável por jobs futuros.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const QUALIFIED = argv.includes('--qualified');
const NO_DEDUP = argv.includes('--no-dedup');
const PAGE = 500;

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  const base = { is_live: { _eq: true } };
  if (QUALIFIED) base.qualified = { _eq: true };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  console.log(`Snapshot-regen (fetch snapshotOnly → industry)${QUALIFIED ? ' | qualificados' : ''}${MIN_SCORE != null ? ` | score >= ${MIN_SCORE}` : ' | TODOS os live'}${LIMIT ? ` | limite ${LIMIT}` : ''}`);

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
      await publishJob(js, SUBJECTS.fetch, { domain: s.domain, siteId: s.id, snapshotOnly: true }, NO_DEDUP ? {} : { msgId: `snapregen:${s.domain}` });
      n++;
    }
    if (n % 10000 === 0) console.log(`  ${n} jobs`);
  }
  console.log(`Concluído. ${n} jobs de snapshot-regen publicados.`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
