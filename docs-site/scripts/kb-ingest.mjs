// Ingere o corpus no Qdrant: content.json → chunks → embeddings (Ollama) → upsert.
// Correr após `npm run content`. Env: OLLAMA_URL, QDRANT_URL, KB_COLLECTION, KB_EMBED_MODEL, KB_EMBED_DIM.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { embed } from '../../lib/kb/embed.mjs';
import { ensureCollection, upsert, count } from '../../lib/kb/qdrant.mjs';
import { htmlToText, chunk } from '../../lib/kb/chunk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const content = JSON.parse(fs.readFileSync(path.join(HERE, '../src/content.json'), 'utf8'));
const COLL = process.env.KB_COLLECTION || 'netprospect_docs';
const DIM = +(process.env.KB_EMBED_DIM || 384);          // all-minilm=384, nomic-embed-text=768
const BATCH = +(process.env.KB_INGEST_BATCH || 24);
const CHUNK_MAX = +(process.env.KB_CHUNK_MAX || 1800);   // chunks maiores = menos embeddings

const chunks = [];
for (const p of content.pages) {
  const text = htmlToText(p.html);
  chunk(text, { max: CHUNK_MAX }).forEach((t, i) =>
    chunks.push({ slug: p.slug, title: p.title, type: p.type, idx: i, text: `# ${p.title}\n\n${t}` }));
}

const created = await ensureCollection(COLL, DIM);
console.log(`Qdrant '${COLL}' ${created ? 'criada' : 'existente'}; ${chunks.length} chunks de ${content.pages.length} docs.`);

let n = 0;
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const vecs = await embed(batch.map((c) => c.text));
  const points = batch.map((c, k) => ({
    id: i + k,
    vector: vecs[k],
    payload: { slug: c.slug, title: c.title, type: c.type, idx: c.idx, text: c.text },
  }));
  await upsert(COLL, points);
  n += points.length;
  process.stdout.write(`\r  ${n}/${chunks.length} chunks embebidos+upserted`);
}
console.log(`\n✓ ${n} chunks no Qdrant. Total na coleção: ${await count(COLL)}.`);
