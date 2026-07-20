// Constrói src/content.json a partir do vault docs/ (+ docs de raiz referenciados).
// Resolve wikilinks [[..]] e links .md relativos para rotas #/, transforma callouts
// Obsidian, e renderiza HTML (markdown-it + highlight.js). Correr: npm run content
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import hljs from 'highlight.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/content.json');

const ROOT_MDS = ['README.md', 'TODO.md', 'GMB-README.md', 'LOAD-DISTRIBUTION.md',
  'BENCHMARK.md', 'DATA-BENCHMARK.md', 'DEBUG-FOUND.md', 'DEBUGGING-TODO.md', 'posthog-setup-report.md'];

const walk = (dir) => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = path.join(dir, e.name);
  return e.isDirectory() ? walk(rel) : rel.endsWith('.md') ? [rel] : [];
});
const rels = [...walk('docs'), ...ROOT_MDS].filter((f) => fs.existsSync(path.join(REPO, f)));

// slug = caminho relativo sem .md (docs/comercial/empresas). Home = docs/README.
const slugOf = (rel) => rel.replace(/\.md$/, '');
const items = rels.map((rel) => {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  let data = {}, content = raw;
  try { const p = matter(raw); data = p.data; content = p.content; }
  catch (e) {                                                  // frontmatter inválido → não crashar
    console.warn(`⚠ frontmatter inválido em ${rel}: ${e.message.split('\n')[0]}`);
    const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
    content = m ? raw.slice(m[0].length) : raw;
  }
  return { rel, slug: slugOf(rel), base: path.basename(rel, '.md'), dir: path.dirname(rel), fm: data, body: content };
});

// mapas de resolução: por basename (Obsidian shortest-path) e por slug-tail.
const byBase = {}; for (const it of items) if (!(it.base in byBase)) byBase[it.base] = it.slug;
const bySlugTail = (t) => items.find((it) => it.slug === t || it.slug.endsWith('/' + t))?.slug;
const resolve = (target, fromDir) => {
  let [p, anchorPart] = target.split('#'); p = p.trim();
  if (p.endsWith('.md')) {                                   // link relativo .md
    const abs = path.normalize(path.join(fromDir, p)).replace(/\\/g, '/');
    const s = slugOf(abs); const hit = items.find((it) => it.slug === s);
    return hit ? '#/' + hit.slug + (anchorPart ? '#' + anchorPart : '') : null;
  }
  const s = bySlugTail(p) || byBase[path.basename(p)];        // wikilink
  return s ? '#/' + s + (anchorPart ? '#' + anchorPart : '') : null;
};

// pré-processa o corpo: wikilinks, links .md relativos, callouts. Acumula arestas do grafo em `links`.
const preprocess = (body, it, links) => {
  let out = body;
  const track = (route) => { if (route) links.add(route.slice(2).split('#')[0]); };
  // callouts Obsidian: "> [!type] Título" → "> **TYPE** — Título"
  out = out.replace(/^> \[!(\w+)\]\s*(.*)$/gm, (_, t, title) =>
    `> **${t.toUpperCase()}**${title.trim() ? ' — ' + title.trim() : ''}`);
  // wikilinks [[target|alias]] / [[target]]
  out = out.replace(/\[\[([^\]]+)\]\]/g, (m, inner) => {
    const [target, alias] = inner.split('|');
    const route = resolve(target, it.dir);
    track(route);
    const label = (alias || target.split('#')[0]).trim();
    return route ? `[${label}](${route})` : `**${label}**`;
  });
  // links markdown relativos para .md → rota #/
  out = out.replace(/\]\((\.[^)]+\.md)(#[^)]*)?\)/g, (m, p, a) => {
    const route = resolve(p + (a || ''), it.dir);
    track(route);
    return route ? `](${route})` : m;
  });
  return out;
};

const md = new MarkdownIt({
  html: true, linkify: true, breaks: false,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) { try { return hljs.highlight(str, { language: lang }).value; } catch {} }
    return '';
  },
}).use(anchor, { permalink: anchor.permalink.headerLink(), slugify: (s) => s.toLowerCase().replace(/[^\w]+/g, '-') });

// ---- Mapeamento doc→módulo (fonte de verdade: plano v2, "Mapa final dos 52 docs") ----
// Chave = slug sem o prefixo "docs/". Precedência: frontmatter `module:` > exacto > prefixo > 'core'.
const stripDocs = (s) => s.replace(/^docs\//, '');
const MODULE_EXACT = {
  README: 'core', TODO: 'core', CONTRIBUTING: 'core', 'DOC-AUDIT': 'core', 'stack-isolation': 'core',
  'distributed-fleet': 'core', 'orphan-offenders': 'core', 'LOAD-DISTRIBUTION': 'core', BENCHMARK: 'core',
  'DATA-BENCHMARK': 'core', 'DEBUG-FOUND': 'core', 'DEBUGGING-TODO': 'core',
  'reference/http-api': 'core', 'reference/modules': 'core',
  observability: 'dashboard/observability', 'subdomain-sources-keys': 'dashboard/prospection',
  'GMB-README': 'workers/gmb', 'posthog-setup-report': 'observability/posthog', 'deploy-watch': 'agents/docker',
  'runbook-laptop': 'agents/windows', 'runbook-laptop-autodeploy': 'agents/windows',
  'runbook-npm-hel1': 'servers/npmplus', 'runbook-server-hel1': 'servers/directus',
  'runbook-worker-vms': 'workers/base', 'runbook-ollama-hel1': 'ai/ollama',
  'runbook-analytics-de': 'data-stores/clickhouse', 'runbook-db-host': 'data-stores/postgresql',
  'runbook-minio-de1': 'data-stores/minio', 'runbook-posthog-cloud': 'observability/posthog',
  'comercial/subscricoes': 'dashboard/store-gate',
  'incidents/README': 'incidents',
  'incidents/20260716-lighthouse-aborts-hel1': 'incidents/workers/browser',
  'incidents/20260717-duplicate-worker-project-npworker': 'incidents/workers/base',
  'incidents/20260719-base-worker-domain-reload-storm': 'incidents/workers/base',
  'outreach-ops/01-validation-fleet': 'workers/verify',
  'outreach-ops/02-reacher': 'workers/verify',
  'outreach-ops/07-reverification-policy': 'workers/verify',
};
const moduleOf = (slug, fm) => {
  if (fm && fm.module) return String(fm.module);
  const s = stripDocs(slug);
  if (s in MODULE_EXACT) return MODULE_EXACT[s];
  if (s.startsWith('comercial/')) return 'dashboard/prospection';       // resto do CRM
  if (s.startsWith('outreach-ops/')) return 'dashboard/email-gateways'; // resto = envio
  if (s.startsWith('incidents/')) return 'incidents';
  return 'core';
};

const edges = [];
const pages = items.map((it) => {
  const links = new Set();
  const html = md.render(preprocess(it.body, it, links));
  for (const t of links) if (t !== it.slug) edges.push({ source: it.slug, target: t });
  const title = it.fm.title || (it.body.match(/^#\s+(.+)$/m)?.[1] || it.base).replace(/[`*_]/g, '').trim();
  const text = it.body.replace(/[#>*`_\-|[\]]/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
  return {
    slug: it.slug, title,
    type: it.fm.type || 'reference', tags: it.fm.tags || [],
    module: moduleOf(it.slug, it.fm),
    status: it.fm.status || '', updated: it.fm.updated || '', owner: it.fm.owner || '',
    visibility: it.fm.visibility || 'internal',
    html, text,
  };
});

// grafo (Graphify): nós = páginas, arestas = wikilinks resolvidos
const nodes = pages.map((p) => ({ id: p.slug, title: p.title, type: p.type, module: p.module }));
const ids = new Set(nodes.map((n) => n.id));
const seen = new Set();
const links = edges
  .filter((e) => ids.has(e.target) && e.source !== e.target)
  .filter((e) => { const k = e.source + '|' + e.target; if (seen.has(k)) return false; seen.add(k); return true; });
const deg = {};
for (const l of links) { deg[l.source] = (deg[l.source] || 0) + 1; deg[l.target] = (deg[l.target] || 0) + 1; }
for (const n of nodes) n.deg = deg[n.id] || 0;

const payload = JSON.stringify({ generated: new Date().toISOString(), home: 'docs/README', pages, graph: { nodes, links } });
fs.writeFileSync(OUT, payload);
// Também como asset estático (public/) → permite refetch em runtime pelo botão "Atualizar" (sem reload da página).
const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/content.json');
fs.mkdirSync(path.dirname(PUB), { recursive: true });
fs.writeFileSync(PUB, payload);
console.log(`${pages.length} páginas, ${nodes.length} nós, ${links.length} arestas → src/content.json (+ public/)`);
