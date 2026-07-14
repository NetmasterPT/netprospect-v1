// enqueue-fine-audits.js
// Produtor das auditorias FINAS — um job por FERRAMENTA, em vez do job monolítico
// `jobs.audit.qualified` (que corria tranco→ollama→lighthouse→nuclei em SÉRIE, num só worker).
//
// PORQUÊ REPARTIR:
//   Cada ferramenta tem um perfil de CPU MUITO diferente (medido):
//     lighthouse (Chromium) ~15s  → CPU-pesado   → role `browser`
//     nuclei                ~50s  → rede + CPU médio → role `security`
//     ollama/industry       ~14s  → CPU-BOUND (o llama.cpp chegou a comer 14 de 18 cores)
//                                                → role `ai`
//   No job monolítico a ferramenta mais lenta bloqueia as outras e a load do host OSCILA.
//   Repartido: cada role vai para a VM com o perfil certo (VMs fracas/free = jobs leves;
//   VMs fortes = carga pesada CONSTANTE), e o Nuclei deixa de bloquear o Lighthouse.
//
//   Como os roles são consumers DIFERENTES, dois hosts com roles distintos NÃO competem
//   no pull da workqueue — a separação por role É a partição (não é preciso fila dedicada).
//
// Uso:
//   node enqueue-fine-audits.js --min-score=50              # lighthouse+nuclei+industry
//   node enqueue-fine-audits.js --min-score=50 --only=nuclei
//   node enqueue-fine-audits.js --only=lighthouse,industry --limit=1000
//
// Resume: salta os que já têm o campo do respetivo job preenchido (--force reprocessa).
// Dedup por Nats-Msg-Id (24h).

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const FORCE = argv.includes('--force');
// --no-dedup: publica SEM Nats-Msg-Id → salta a janela de dedup de 24h. Necessário para
// RE-enfileirar um job cujos msgIds ainda estão na janela (ex.: trocar o classificador de
// industry e re-processar hoje). Seguro num enqueue de uma passagem (cada domínio 1×).
const NO_DEDUP = argv.includes('--no-dedup');
const BY_SCORE = argv.includes('--by-score'); // ordena lead_score DESC (leads de maior valor primeiro)
const ONLY = flag('only', 'lighthouse,nuclei,industry').split(',').map((s) => s.trim()).filter(Boolean);
const PAGE = 500;

// job -> { subject, role, campo de resume }
const JOBS = {
  lighthouse: { subject: SUBJECTS.lighthouseMobile, role: 'browser', resume: 'seo_score' },
  lighthouse_desktop: { subject: SUBJECTS.lighthouseDesktop, role: 'browser', resume: 'perf_desktop' },
  nuclei: { subject: SUBJECTS.nuclei, role: 'security', resume: 'security_findings' },
  industry: { subject: SUBJECTS.industry, role: 'ai', resume: 'industry' },
  wpscan: { subject: SUBJECTS.wpscan, role: 'security', resume: 'wp_vuln_count' },
  gmb: { subject: SUBJECTS.gmb, role: 'residential', resume: 'gmb_name' },
};

async function main() {
  const bad = ONLY.filter((o) => !JOBS[o]);
  if (bad.length) { console.error(`--only inválido: ${bad.join(',')} (válidos: ${Object.keys(JOBS).join(',')})`); process.exit(1); }

  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  // O resume usa o campo do PRIMEIRO job pedido (os jobs são independentes: para um resume
  // exato por-ferramenta, correr um `--only` de cada vez).
  const base = { qualified: { _eq: true }, is_live: { _eq: true } };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  const resumeField = JOBS[ONLY[0]].resume;
  if (!FORCE) base[resumeField] = { _null: true };

  console.log(`Auditorias FINAS → ${ONLY.map((o) => `${o}(${JOBS[o].role})`).join(' + ')}`
    + `${MIN_SCORE != null ? ` | lead_score >= ${MIN_SCORE}` : ''}`
    + `${FORCE ? ' (force)' : ` | resume: ${resumeField} IS NULL`}${LIMIT ? ` | limite ${LIMIT}` : ''}`);

  let lastId = 0, lastScore = null, sites = 0, jobs = 0;
  for (;;) {
    if (LIMIT && sites >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - sites) : PAGE;
    const cursor = BY_SCORE
      ? (lastScore == null ? {} : { _or: [{ lead_score: { _lt: lastScore } }, { _and: [{ lead_score: { _eq: lastScore } }, { id: { _gt: lastId } }] }] })
      : { id: { _gt: lastId } };
    const rows = await client.request(readItems('sites', {
      filter: { ...base, ...cursor }, fields: ['id', 'domain', 'lead_score'], sort: BY_SCORE ? ['-lead_score', 'id'] : ['id'], limit: pageSize,
    }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id; lastScore = rows[rows.length - 1].lead_score;
    for (const s of rows) {
      for (const o of ONLY) {
        await publishJob(js, JOBS[o].subject, { domain: s.domain, siteId: s.id }, NO_DEDUP ? {} : { msgId: `${o}:${s.domain}` });
        jobs++;
      }
      sites++;
    }
    console.log(`  ${sites} sites / ${jobs} jobs`);
  }
  console.log(`Concluído. ${sites} sites, ${jobs} jobs publicados (${ONLY.join('+')}).`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
