// Ingere o corpus no Qdrant numa COLEÇÃO ÚNICA (KB_COLLECTION) com payload.module → a federação por-módulo
// faz-se por FILTRO do Qdrant (escape hatch: N coleções pequenas esgotam recursos do Qdrant). IDs estáveis
// (UUID determinístico de `slug#idx`) → re-ingest sobrescreve, não duplica. Correr após `npm run content`.
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { embed } from '../kb/embed.mjs';
import { ensureCollection, upsert, count } from '../kb/qdrant.mjs';
import { htmlToText, chunk } from '../kb/chunk.mjs';
import { KB_COLLECTION } from '../kb/registry.mjs';

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

const chunks = [];
const perModule = {};
for (const p of content.pages) {
  const mod = p.module || 'core';
  perModule[mod] = (perModule[mod] || 0) + 1;
  const text = htmlToText(p.html);
  chunk(text, { max: CHUNK_MAX }).forEach((t, i) =>
    chunks.push({ slug: p.slug, title: p.title, type: p.type, module: mod, idx: i, text: `# ${p.title}\n\n${t}` }));
}

const created = await ensureCollection(KB_COLLECTION, DIM);
console.log(`Qdrant '${KB_COLLECTION}' ${created ? 'criada' : 'existente'}; ${chunks.length} chunks de ${content.pages.length} docs em ${Object.keys(perModule).length} módulos.`);

let n = 0;
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const vecs = await embed(batch.map((c) => c.text));
  const points = batch.map((c, k) => ({
    id: uuidFor(`${c.slug}#${c.idx}`),
    vector: vecs[k],
    payload: { slug: c.slug, title: c.title, type: c.type, module: c.module, idx: c.idx, text: c.text },
  }));
  await upsert(KB_COLLECTION, points);
  n += points.length;
  process.stdout.write(`\r  ${n}/${chunks.length} chunks embebidos+upserted`);
}
console.log(`\n✓ ${n} chunks no Qdrant. Total na coleção '${KB_COLLECTION}': ${await count(KB_COLLECTION)}.`);
