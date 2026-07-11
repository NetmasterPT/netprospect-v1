// enqueue-enrich.js
// Produtor: lê uma lista de domínios (out/dominios_<tld>.txt) e publica um job
// `jobs.enrich` por domínio no NATS JetStream. Idempotente (dedup por
// Nats-Msg-Id=`enrich:<domínio>`) e retomável (salta os que já têm `checked_at`
// no Directus, salvo --force).
//
// Uso:
//   node enqueue-enrich.js --input=out/dominios_se.txt
//   node enqueue-enrich.js --input=out/dominios_se.txt --limit=1000 --force

import fs from 'fs';
import { domainToASCII } from 'node:url';
import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const INPUT = flag('input', 'out/dominios_pt.txt');
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const FORCE = argv.includes('--force');
// --fine publica o root FINO (jobs.fetch → DAG) em vez do coarse (jobs.enrich).
const FINE = argv.includes('--fine');
const ROOT_SUBJECT = FINE ? SUBJECTS.fetch : SUBJECTS.enrich;
const MSG_PREFIX = FINE ? 'fetch' : 'enrich';

async function loadDone(client) {
  const done = new Set();
  try {
    const rows = await client.request(readItems('sites', { filter: { checked_at: { _nnull: true } }, fields: ['domain'], limit: -1 }));
    for (const s of rows) done.add(s.domain);
  } catch { /* coleção vazia */ }
  return done;
}

async function main() {
  if (!fs.existsSync(INPUT)) { console.error(`Input não encontrado: ${INPUT}`); process.exit(1); }
  let domains = fs.readFileSync(INPUT, 'utf8').split('\n').map((d) => d.trim().toLowerCase()).filter(Boolean).map((d) => domainToASCII(d) || d);
  domains = [...new Set(domains)];

  const client = makeClient();
  const done = FORCE ? new Set() : await loadDone(client);
  let queue = domains.filter((d) => !done.has(d));
  if (LIMIT) queue = queue.slice(0, LIMIT);
  console.log(`Input: ${domains.length} | já feitos: ${done.size} | a enfileirar: ${queue.length}`);

  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  let n = 0;
  for (const domain of queue) {
    await publishJob(js, ROOT_SUBJECT, { domain }, { msgId: `${MSG_PREFIX}:${domain}` });
    if (++n % 1000 === 0) console.log(`  enfileirados ${n}/${queue.length}`);
  }
  console.log(`Concluído. ${n} jobs ${ROOT_SUBJECT} publicados (dedup por Nats-Msg-Id).`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err); process.exit(1); });
