// enqueue-registry.js — enfileira `jobs.registry` (enriquecimento por REGISTO de empresas oficial:
// nº de registo do site → dimensão + CAE oficial + DECISORES NOMEADOS). Ver lib/company-registry.js.
//
// Só faz sentido para TLDs com registo LIGADO — hoje **só NO** (brreg, aberto/grátis). Precisa do
// snapshot no MinIO (o Org.nr vem do HTML) → alvo: sites live com empresa. Resume: company.reg_checked_at NULL.
//
//   node enqueue-registry.js --tld=no                       # todos os .no live não-checados
//   node enqueue-registry.js --tld=no --min-score=50        # só leads >=50
//   node enqueue-registry.js --tld=no --limit=300 --dry-run
//
// `registry` é role `base`. Custo: 1–2 lookups HTTP ao brreg por site (com Org.nr). Sem Org.nr no site → no-op.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const TLD = (flag('tld', 'no') || 'no').replace(/^\.+/, '').toLowerCase();
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const FORCE = argv.includes('--force');
const NO_DEDUP = argv.includes('--no-dedup');
const DRY = argv.includes('--dry-run');
const PAGE = 500;

async function main() {
  if (TLD !== 'no') { console.error(`Só o registo NO está ligado. --tld=${TLD} não tem registo → nada a fazer.`); process.exit(1); }
  const client = makeClient();
  const base = { is_live: { _eq: true }, domain: { _ends_with: '.' + TLD } };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  base.company = FORCE ? { _nnull: true } : { reg_checked_at: { _null: true } }; // resume por empresa não-checada
  console.log(`Registry (.${TLD} → brreg)${MIN_SCORE != null ? ` | score >= ${MIN_SCORE}` : ''}${FORCE ? ' (force)' : ' | resume: reg_checked_at NULL'}${LIMIT ? ` | limite ${LIMIT}` : ''}${DRY ? '  [DRY-RUN]' : ''}`);

  let js = null, nc = null;
  if (!DRY) { nc = await connectJobs(); await ensureStream(nc); js = nc.jetstream(); }
  const readRetry = async (opts, tries = 6) => {
    for (let i = 0; ; i++) {
      try { return await client.request(readItems('sites', opts)); }
      catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
    }
  };
  let lastId = 0, n = 0;
  for (;;) {
    if (LIMIT && n >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - n) : PAGE;
    const rows = await readRetry({ filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain'], sort: ['id'], limit: pageSize });
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) {
      if (!DRY) await publishJob(js, SUBJECTS.registry, { domain: s.domain, siteId: s.id }, NO_DEDUP ? {} : { msgId: `registry:${s.domain}` });
      n++;
    }
    if (n % 2000 === 0) console.log(`  ${n} jobs`);
  }
  console.log(`Concluído. ${n} jobs de registry ${DRY ? 'a publicar (DRY-RUN, nada enviado)' : 'publicados'}.`);
  if (!DRY) await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
