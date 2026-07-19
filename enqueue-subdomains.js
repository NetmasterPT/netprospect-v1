// enqueue-subdomains.js
// Produtor: publica `jobs.subdomains` para os sites (por omissão qualificados sem
// hostnames). Os workers subdomain (idealmente atrás de exit nodes Tailscale
// diferentes — Fase C) consomem a fila e enumeram via crt.sh, espalhando a pressão
// de ligações do crt.sh por vários IPs.
//
// Uso: node enqueue-subdomains.js [--all] [--limit=1000] [--force] [--min-score=45]

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const ALL = argv.includes('--all');
const FORCE = argv.includes('--force');
const PAGE = 500;

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();
  const base = ALL ? { is_live: { _eq: true } } : { qualified: { _eq: true } };
  if (!FORCE) base.hostnames = { _null: true };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  let lastId = 0, n = 0;
  for (;;) {
    if (LIMIT && n >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - n) : PAGE;
    const rows = await client.request(readItems('sites', { filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain'], sort: ['id'], limit: pageSize }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) { await publishJob(js, SUBJECTS.subdomains, { domain: s.domain, siteId: s.id, force: FORCE }, { msgId: `subdomains:${s.domain}` }); n++; }
    console.log(`  enfileirados ${n}`);
  }
  console.log(`Concluído. ${n} jobs.subdomains publicados.`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
