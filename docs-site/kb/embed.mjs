// Embeddings via Ollama (hel1-ollama, tailnet). Modelo default: nomic-embed-text (768 dims).
// Usa /api/embed (batch, Ollama recente) com fallback para /api/embeddings (por-texto, antigo).
// all-minilm (384-dim) — leve e rápido q.b. no Ollama CPU; nomic-embed-text (768) é alternativa.
const OLLAMA = () => (process.env.OLLAMA_URL || 'http://100.126.196.112:11434').replace(/\/$/, '');
const MODEL = () => process.env.KB_EMBED_MODEL || 'all-minilm';

export async function embed(input, { url = OLLAMA(), model = MODEL() } = {}) {
  const batch = Array.isArray(input) ? input : [input];
  // tentativa 1: /api/embed (batch)
  let r = await fetch(`${url}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: batch }),
  });
  if (r.ok) {
    const j = await r.json();
    const vecs = j.embeddings || (j.embedding ? [j.embedding] : []);
    if (vecs.length) return Array.isArray(input) ? vecs : vecs[0];
  }
  // fallback: /api/embeddings (um pedido por texto)
  const out = [];
  for (const prompt of batch) {
    const rr = await fetch(`${url}/api/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt }),
    });
    if (!rr.ok) throw new Error(`ollama embeddings HTTP ${rr.status}`);
    out.push((await rr.json()).embedding);
  }
  return Array.isArray(input) ? out : out[0];
}
