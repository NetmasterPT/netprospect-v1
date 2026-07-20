// enqueue-reextract.js
// RE-CORRE os extractors on-site (contacts/social/locality/fingerprint) já CORRIGIDOS sobre a base
// existente, por BANDA de lead_score (maior valor primeiro), para limpar a "poison-DB" (pessoas
// inválidas, has_decision_maker falso, socials/moradas em falta) que o extractor antigo gravou.
//
// Publica `fetch` com { reextract:true } → handleFetch: se houver snapshot COMPLETO reutiliza-o (sem
// rede), senão re-busca homepage + páginas de contacto; depois fan-out p/ os extractors, e o `contacts`
// PURGA as linhas-máquina obsoletas antes de reinserir (preserva revistos/DNC/verificados). Ver
// .claude/plans/current/backlog-roadmap.md (Fase 1b) e DATA-BENCHMARK.md.
//
//   node enqueue-reextract.js --min-score=60 --by-score        # banda >=60, leads de maior valor 1º
//   node enqueue-reextract.js --min-score=50 --by-score --limit=2000
//   node enqueue-reextract.js --all --min-score=40             # inclui não-qualificados live
//   node enqueue-reextract.js --min-score=60 --dry-run         # conta, não publica
//
// Resume: salta sites já re-extraídos (contacts_checked_at >= --since, default a data da campanha) →
// re-arranca em segurança e não re-faz trabalho. --force ignora o corte. `fetch` é role `base`.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null;
const ALL = argv.includes('--all');                 // inclui live não-qualificados (default: só qualificados)
const FORCE = argv.includes('--force');             // ignora o corte de resume (re-corre tudo)
const BY_SCORE = argv.includes('--by-score');       // ordena lead_score DESC (leads de maior valor 1º)
const NO_DEDUP = argv.includes('--no-dedup');       // publica sem msgId (re-enfileirar dentro da janela de 24h)
const DRY = argv.includes('--dry-run');
const SINCE = flag('since', '2026-07-20');           // corte: contactos extraídos ANTES disto = envenenados (pré-campanha)
const PAGE = 500;

async function main() {
  const client = makeClient();
  const base = ALL ? { is_live: { _eq: true } } : { qualified: { _eq: true }, is_live: { _eq: true } };
  if (MIN_SCORE != null) base.lead_score = { _gte: MIN_SCORE };
  // Resume (separado do base p/ não colidir com o _or do cursor by-score): só sites cujos contactos
  // foram extraídos ANTES do corte (ou nunca) → salta os já re-extraídos nesta campanha.
  const resumeOr = FORCE ? null : [{ contacts_checked_at: { _null: true } }, { contacts_checked_at: { _lt: SINCE } }];

  console.log(`Re-extract (fetch reextract → contacts/social/locality/fingerprint)`
    + `${ALL ? ' | live' : ' | qualificados'}${MIN_SCORE != null ? ` | score >= ${MIN_SCORE}` : ''}`
    + `${BY_SCORE ? ' | by-score' : ''}${FORCE ? ' (force)' : ` | resume: contacts_checked_at < ${SINCE} ou NULL`}`
    + `${LIMIT ? ` | limite ${LIMIT}` : ''}${DRY ? '  [DRY-RUN]' : ''}`);

  let js = null, nc = null;
  if (!DRY) { nc = await connectJobs(); await ensureStream(nc); js = nc.jetstream(); }

  // Directus sob carga devolve "fetch failed"/503 transitórios → retry com backoff.
  const readRetry = async (opts, tries = 6) => {
    for (let i = 0; ; i++) {
      try { return await client.request(readItems('sites', opts)); }
      catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
    }
  };

  let lastId = 0, lastScore = null, n = 0;
  for (;;) {
    if (LIMIT && n >= LIMIT) break;
    const pageSize = LIMIT ? Math.min(PAGE, LIMIT - n) : PAGE;
    // Cada cláusula (base, resume _or, cursor _or) num membro próprio do _and → os _or não se sobrepõem.
    const cursor = BY_SCORE
      ? (lastScore == null ? null : { _or: [{ lead_score: { _lt: lastScore } }, { _and: [{ lead_score: { _eq: lastScore } }, { id: { _gt: lastId } }] }] })
      : { id: { _gt: lastId } };
    const parts = [base];
    if (resumeOr) parts.push({ _or: resumeOr });
    if (cursor) parts.push(cursor);
    const filter = parts.length > 1 ? { _and: parts } : parts[0];
    const rows = await readRetry({ filter, fields: ['id', 'domain', 'lead_score'], sort: BY_SCORE ? ['-lead_score', 'id'] : ['id'], limit: pageSize });
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id; lastScore = rows[rows.length - 1].lead_score;
    for (const s of rows) {
      if (!DRY) await publishJob(js, SUBJECTS.fetch, { domain: s.domain, siteId: s.id, reextract: true }, NO_DEDUP ? {} : { msgId: `reextract:${s.domain}` });
      n++;
    }
    if (n % 5000 === 0) console.log(`  ${n} jobs`);
  }
  console.log(`Concluído. ${n} jobs de re-extract ${DRY ? 'a publicar (DRY-RUN, nada enviado)' : 'publicados'}.`);
  if (!DRY) await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
