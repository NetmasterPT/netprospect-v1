// docs-site/mcp/notebook.mjs — escalada do chat dos docs para o Open Notebook (deep-research self-hosted).
// O kb-http fala com a API pela rede npdocs (OPEN_NOTEBOOK_API_URL=http://open-notebook:5055); o deep-link
// é o URL PÚBLICO (netprospect.notebook.netmaster.pt). Semeia a pergunta+resposta+citações num notebook
// canónico e devolve o link para o utilizador aprofundar na UI (que já tem os modelos configurados).
// URL INTERNA (kb-http→open-notebook pela rede npdocs) — distinta do OPEN_NOTEBOOK_API_URL do .env,
// que é o API_URL do BROWSER (ts.net) e um container não alcança bem.
const API = () => (process.env.OPEN_NOTEBOOK_INTERNAL_URL || 'http://open-notebook:5055').replace(/\/$/, '');
const PUBLIC = () => (process.env.OPEN_NOTEBOOK_PUBLIC_URL || 'https://netprospect.notebook.netmaster.pt').replace(/\/$/, '');
const NB_NAME = () => process.env.OPEN_NOTEBOOK_NAME || 'NetProspect Docs';

export const notebookEnabled = () => !!API();

async function api(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const r = await fetch(`${API()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Open Notebook ${method} ${path} → HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// Notebook canónico — procura por nome, cria 1x, reutiliza depois.
async function ensureNotebook() {
  const list = await api('/api/notebooks').catch(() => []);
  const found = Array.isArray(list) ? list.find((n) => n.name === NB_NAME()) : null;
  if (found) return found;
  return api('/api/notebooks', {
    method: 'POST',
    body: { name: NB_NAME(), description: 'Escaladas de pesquisa a partir do chat dos docs NetProspect.' },
  });
}

// Semeia a pergunta + resposta + citações como source de texto (via /api/sources/json — o /api/sources
// cru é multipart) e devolve o deep-link. Fail-soft no source: mesmo que falhe, devolve o link do notebook.
export async function escalate({ question, answer = '', citations = [] }) {
  if (!notebookEnabled()) throw new Error('Open Notebook não configurado (OPEN_NOTEBOOK_API_URL).');
  const q = String(question || '').trim();
  if (!q) throw new Error('pergunta vazia');
  const nb = await ensureNotebook();
  const nbId = nb.id || nb.notebook_id;
  const cites = (citations || []).length
    ? `\n\n## Fontes citadas\n${citations.map((c) => `- ${c.title || c.slug || '?'}${c.slug ? ` — /docs/#/${c.slug}` : ''}`).join('\n')}`
    : '';
  const content = `# ${q}\n\n${answer ? `## Resposta do chat dos docs\n${answer}\n` : ''}${cites}`.trim();
  await api('/api/sources/json', {
    method: 'POST',
    body: { type: 'text', notebooks: [nbId], title: q.slice(0, 120), content, embed: false, async_processing: true },
  }).catch((e) => console.error('notebook source falhou (link na mesma):', e.message));
  return { ok: true, notebookId: nbId, deepLink: PUBLIC() };
}
