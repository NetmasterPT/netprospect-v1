// docs-site/kb/registry.mjs — carrega o registry (config/kb-registry.json) + resolve o perfil ativo
// (config/plans.json via lib/entitlements.js) → coleções Qdrant federadas. As "active modules" derivam do
// CONTEÚDO (content.json distinct page.module) — é a fonte de verdade do que foi ingerido; o registry dá os
// metadados (label/status) para o endpoint /modules. 'core' está SEMPRE ativo (KB central base).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planModules } from '../../lib/entitlements.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REG_PATH = process.env.KB_REGISTRY || path.resolve(HERE, '../../config/kb-registry.json');
const CONTENT = process.env.KB_CONTENT || path.resolve(HERE, '../src/content.json');
const PREFIX = process.env.KB_COLLECTION_PREFIX || 'kb_';
const DEFAULT_PROFILE = process.env.DOCS_PROFILE || 'interno';

let _reg = null, _content = null;
export const registry = () => (_reg ||= JSON.parse(fs.readFileSync(REG_PATH, 'utf8')));
const content = () => (_content ||= JSON.parse(fs.readFileSync(CONTENT, 'utf8')));

/** Coleção Qdrant p/ um module tag (ex.: 'dashboard/prospection' → 'kb_dashboard_prospection'). */
export const collectionFor = (tag) =>
  PREFIX + String(tag).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();

/** Module tags com conteúdo (distintos em content.json). */
export function contentModules() {
  const set = new Set();
  for (const p of content().pages || []) if (p.module) set.add(p.module);
  return [...set].sort();
}

/** Um pattern do plano (config/plans.json) casa com um module tag? */
function patternMatches(pat, tag) {
  if (pat === '*' || pat === '@all') return true;
  if (pat === tag) return true;
  if (pat.endsWith('/*')) { const b = pat.slice(0, -2); return tag === b || tag.startsWith(b + '/'); }
  if (!pat.includes('/') && tag.startsWith(pat + '/')) return true; // categoria casa os seus módulos
  return false;
}

/** Module tags ativos p/ um perfil (default 'interno'='*'=tudo). 'core' sempre incluído. */
export function activeModules(profile = DEFAULT_PROFILE) {
  const tags = contentModules();
  let allowed;
  try { allowed = planModules(profile); } catch { allowed = ['*']; }
  if (!allowed || !allowed.length || allowed.includes('*')) return tags;
  const active = tags.filter((t) => t === 'core' || allowed.some((p) => patternMatches(p, t)));
  return active.length ? active : ['core'];
}

export const activeCollections = (profile) => activeModules(profile).map(collectionFor);

/** Tag canónico de um módulo do registry (categorias `flat` não prefixam: platform/core → 'core'). */
function tagOf(cat, m) { return cat.flat ? m.id : `${cat.id}/${m.id}`; }

/** Vista p/ o endpoint /modules: cada module tag COM conteúdo, anotado com metadados do registry. */
export function modulesView(profile = DEFAULT_PROFILE) {
  const active = new Set(activeModules(profile));
  const withContent = contentModules();
  // metadados por tag a partir do registry
  const meta = {};
  for (const cat of registry().categories || []) {
    for (const m of cat.modules || []) meta[tagOf(cat, m)] = { category: cat.id, label: m.label, status: m.status };
  }
  const counts = {};
  for (const p of content().pages || []) counts[p.module] = (counts[p.module] || 0) + 1;
  return withContent.map((tag) => ({
    id: tag,
    category: meta[tag]?.category || tag.split('/')[0],
    label: meta[tag]?.label || tag,
    status: meta[tag]?.status || 'active',
    collection: collectionFor(tag),
    docs: counts[tag] || 0,
    active: active.has(tag),
  }));
}
