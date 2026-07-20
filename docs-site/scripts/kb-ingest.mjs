// Ingere o corpus no Qdrant, UMA COLEÇÃO POR MÓDULO (kb_<cat>_<mod>): content.json → chunks → embeddings →
// upsert. IDs estáveis (UUID determinístico de `slug#idx`) → re-ingest sobrescreve, não duplica. payload.module
// permite filtrar/federar. Correr após `npm run content`. Env: OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, KB_EMBED_DIM.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { embed } from '../kb/embed.mjs';
import { ensureCollection, upsert, count } from '../kb/qdrant.mjs';
import { htmlToText, chunk } from '../kb/chunk.mjs';
import { collectionFor } from '../kb/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const content = JSON.parse(fs.readFileSync(path.join(HERE, '../src/content.json'), 'utf8'));
const DIM = +(process.env.KB_EMBED_DIM || 384);          // all-minilm/paraphrase=384, nomic-embed-text=768
const BATCH = +(process.env.KB_INGEST_BATCH || 24);
const CHUNK_MAX = +(process.env.KB_CHUNK_MAX || 1800);

// UUID determinístico (sha1 → formato UUID) → id estável por chunk.
const uuidFor = (s) => {
  const h = crypto.createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// agrupa chunks por coleção (derivada de page.module).
const byColl = new Map();
for (const p of content.pages) {
  const mod = p.module || 'core';
  const coll = collectionFor(mod);
  const text = htmlToText(p.html);
  chunk(text, { max: CHUNK_MAX }).forEach((t, i) => {
    if (!byColl.has(coll)) byColl.set(coll, []);
    byColl.get(coll).push({ slug: p.slug, title: p.title, type: p.type, module: mod, idx: i, text: `# ${p.title}\n\n${t}` });
  });
}

console.log(`${content.pages.length} docs → ${byColl.size} coleções por-módulo:`);
let total = 0;
for (const [coll, cks] of [...byColl].sort()) {
  const created = await ensureCollection(coll, DIM);
  let n = 0;
  for (let i = 0; i < cks.length; i += BATCH) {
    const batch = cks.slice(i, i + BATCH);
    const vecs = await embed(batch.map((c) => c.text));
    const points = batch.map((c, k) => ({
      id: uuidFor(`${c.slug}#${c.idx}`),
      vector: vecs[k],
      payload: { slug: c.slug, title: c.title, type: c.type, module: c.module, idx: c.idx, text: c.text },
    }));
    await upsert(coll, points);
    n += points.length;
  }
  total += n;
  console.log(`  ${coll.padEnd(34)} ${String(n).padStart(3)} chunks (total ${await count(coll)})${created ? ' [nova]' : ''}`);
}
console.log(`✓ ${total} chunks em ${byColl.size} coleções.`);
