// Lógica dos tools de conhecimento (partilhada pelo HTTP e pelo MCP).
// Carrega content.json (docs + grafo) e usa Qdrant (search) + Ollama (embed do query).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { embed } from '../kb/embed.mjs';
import { search } from '../kb/qdrant.mjs';
import { htmlToText } from '../kb/chunk.mjs';
import { moduleFilter, KB_COLLECTION, contentModules, activeModules } from '../kb/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = process.env.KB_CONTENT || path.join(HERE, '../src/content.json');
// search_docs só precisa do Qdrant; get_doc/list_related precisam do content.json. Não crashar se faltar.
let content = { pages: [], graph: { nodes: [], links: [] }, generated: null };
try { content = JSON.parse(fs.readFileSync(CONTENT, 'utf8')); }
catch { console.error(`kb: content.json não encontrado (${CONTENT}) — corre \`npm run content\`. search_docs continua a funcionar via Qdrant.`); }
const bySlug = Object.fromEntries(content.pages.map((p) => [p.slug, p]));

// Search FEDERADO: embed 1× → 1 coleção (KB_COLLECTION) + FILTRO por-módulo do perfil (Qdrant) → top-N.
export async function searchDocs(query, limit = 8, profile) {
  const vec = await embed(String(query || ''));
  const k = Math.min(+limit || 8, 25);
  const hits = await search(KB_COLLECTION, vec, k, moduleFilter(profile) || undefined);
  return hits.map((h) => ({
    slug: h.payload.slug, title: h.payload.title, type: h.payload.type, module: h.payload.module,
    score: +Number(h.score).toFixed(3), text: h.payload.text,
  }));
}
export function getDoc(slug) {
  const p = bySlug[slug] || bySlug[String(slug).replace(/\.md$/, '')];
  if (!p) return null;
  return { slug: p.slug, title: p.title, type: p.type, tags: p.tags, updated: p.updated, text: htmlToText(p.html) };
}
export function listRelated(slug) {
  const dir = new Map();
  for (const l of content.graph.links) {
    if (l.source === slug && bySlug[l.target]) dir.set(l.target, dir.get(l.target) || 'out');
    if (l.target === slug && bySlug[l.source]) dir.set(l.source, dir.get(l.source) || 'in');
  }
  return [...dir.keys()].map((s) => ({ slug: s, title: bySlug[s].title, type: bySlug[s].type, dir: dir.get(s) }));
}
export const meta = () => ({
  docs: content.pages.length, generated: content.generated,
  modules: contentModules().length, activeModules: activeModules().length, collection: KB_COLLECTION,
});
