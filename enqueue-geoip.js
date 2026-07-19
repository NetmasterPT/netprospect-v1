// enqueue-geoip.js
// Produtor do geoip. Normalmente o geoip é publicado INLINE pelo fetch (worker/handlers.mjs:
// `pub(SUBJECTS.geoip, { domain, siteId, ip: hosting_ip })`), por isso não tinha produtor próprio.
// Este preenche as LACUNAS por banda: sites qualified+live que TÊM hosting_ip mas ainda não têm
// ip_country (o fetch correu antes do geoip, ou o geoip falhou). Marcador de cobertura = ip_country.
//
// Uso:
//   node enqueue-geoip.js --min-score=45           # os bons leads primeiro
//   node enqueue-geoip.js --limit=1000
//   node enqueue-geoip.js --force                  # reprocessa (ignora o resume ip_country)
//
// Resume: salta os que já têm ip_country (--force reprocessa). Dedup por Nats-Msg-Id (24h).

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const FORCE = argv.includes('--force');
const PAGE = 500;

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();
  // Precondição: precisa de IP (o geoip resolve país/cidade/ISP a partir do hosting_ip).
  const base = { qualified: { _eq: true }, is_live: { _eq: true }, hosting_ip: { _nnull: true } };
  if (!FORCE) base.ip_country = { _null: true };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  console.log(`geoip → resume: ${FORCE ? '(force)' : 'ip_country IS NULL'}${MIN_SCORE != null ? ` | score>=${MIN_SCORE}` : ''}${LIMIT ? ` | limite ${LIMIT}` : ''}`);
  let lastId = 0, n = 0;
  for (;;) {
    if (LIMIT && n >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - n) : PAGE;
    const rows = await client.request(readItems('sites', { filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain', 'hosting_ip'], sort: ['id'], limit: pageSize }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) { await publishJob(js, SUBJECTS.geoip, { domain: s.domain, siteId: s.id, ip: s.hosting_ip }, { msgId: `geoip:${s.domain}` }); n++; }
    console.log(`  enfileirados ${n}`);
  }
  console.log(`Concluído. ${n} jobs.geoip publicados.`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
