// enqueue-wpscan.js
// BATCH keyless do WPScan para TODOS os sites WordPress (não on-demand).
//
// PORQUÊ SEPARADO do enqueue-fine-audits:
//   - só faz sentido em sites WordPress (primary_platform.slug='wordpress') → filtro próprio;
//   - corre SEM API key (keyless): enumera plugins/temas/versão/users/config-backups, mas NÃO
//     traz o vuln-DB do WPScan. Assim a quota de 25/dia/key fica reservada para o ON-DEMAND
//     (o botão "WPScan" no dashboard, que usa a WPSCAN_API_TOKEN do host).
//   - o handler corre keyless porque o job leva `{ keyless: true }` (worker/worker.mjs:wpscan).
//
// Role `security` (network-bound) → escala pela frota de VMs fracas/free.
//
// Uso:
//   node enqueue-wpscan.js                      # todos os WP live sem wpscan ainda
//   node enqueue-wpscan.js --min-score=50       # primeiro os bons leads
//   node enqueue-wpscan.js --limit=5000         # um lote
//   node enqueue-wpscan.js --force              # reprocessa (ignora o resume)
//
// Resume: salta os que já têm wp_vuln_count. Dedup por Nats-Msg-Id (24h) salvo --no-dedup.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const FORCE = argv.includes('--force');
const NO_DEDUP = argv.includes('--no-dedup');
const PAGE = 500;

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  // Só WordPress + vivo. (NÃO exige `qualified`: o utilizador quer TODOS os sites WordPress.)
  const base = { is_live: { _eq: true }, primary_platform: { slug: { _eq: 'wordpress' } } };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  if (!FORCE) base.wp_vuln_count = { _null: true };

  console.log(`WPScan BATCH keyless → WordPress live`
    + `${MIN_SCORE != null ? ` | lead_score >= ${MIN_SCORE}` : ''}`
    + `${FORCE ? ' (force)' : ' | resume: wp_vuln_count IS NULL'}${LIMIT ? ` | limite ${LIMIT}` : ''}`);

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
      await publishJob(js, SUBJECTS.wpscan, { domain: s.domain, siteId: s.id, keyless: true }, NO_DEDUP ? {} : { msgId: `wpscan:${s.domain}` });
      n++;
    }
    console.log(`  ${n} publicados`);
  }
  console.log(`Concluído. ${n} jobs WPScan keyless publicados.`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
