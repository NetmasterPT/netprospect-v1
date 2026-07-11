// enqueue-retries.js — re-enfileira as FALHAS dos logs standalone via a fila correta.
//   extract-*.log  (falha de extração de contactos)  → jobs.contacts { domain }
//   enrich-*.log   (falha de enriquecimento)         → jobs.enrich  { domain }
// Idempotente (msgId com prefixo retry:). Os host jobs continuam a correr; estes
// retries são drenados pelo worker-base. Uso: node enqueue-retries.js [--dry-run]
import fs from 'node:fs';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const DRY = process.argv.includes('--dry-run');
const NATS = process.env.NATS_URL || 'nats://localhost:4222';

// Extrai domínios de linhas de erro:  "  ! <domain>: ..."  ou  "  ! upsert <domain>: ..."
function failedFrom(file) {
  const out = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*!\s+(?:upsert\s+)?([a-z0-9.-]+\.[a-z]{2,}):/i);
      if (m) out.add(m[1].trim().toLowerCase());
    }
  } catch { /* ficheiro ausente */ }
  return out;
}

const extractFails = new Set([...failedFrom('out/extract-no-force.log'), ...failedFrom('out/extract-pt-force.log')]);
const enrichFails = failedFrom('out/enrich-nl-p.log');
// Se um domínio falhou em ambos, o enrich vem primeiro (recria o site → depois contacts no cascade).
for (const d of enrichFails) extractFails.delete(d);

console.log(`Falhas: ${extractFails.size} extract→contacts, ${enrichFails.size} enrich→enrich.${DRY ? '  [DRY-RUN]' : ''}`);
if (DRY) { console.log('Amostra contacts:', [...extractFails].slice(0, 3).join(', ')); console.log('Amostra enrich:', [...enrichFails].slice(0, 3).join(', ')); process.exit(0); }

const nc = await connectJobs(NATS);
await ensureStream(nc);
const js = nc.jetstream();
let c = 0, e = 0;
for (const domain of enrichFails) { await publishJob(js, SUBJECTS.enrich, { domain }, { msgId: `enrich:retry:${domain}` }); if (++e % 500 === 0) console.log(`  enrich ${e}…`); }
for (const domain of extractFails) { await publishJob(js, SUBJECTS.contacts, { domain }, { msgId: `contacts:retry:${domain}` }); if (++c % 500 === 0) console.log(`  contacts ${c}…`); }
console.log(`\n✓ Enfileirados: ${e} enrich + ${c} contacts = ${e + c} retries. O worker-base drena.`);
await nc.drain();
