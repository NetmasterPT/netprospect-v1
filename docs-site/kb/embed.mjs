// Embeddings para o RAG. Dois backends:
//  - 'local' (DEFAULT): transformers.js in-process (ONNX). Multilingue (PT), ~8ms/texto em CPU,
//    offline após o 1º load. Modelo: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384-dim).
//  - 'ollama': o Ollama remoto (hel1-ollama). Mais lento no CPU (~2.6s/texto); mantido como alternativa.
// Trocar via KB_EMBED_BACKEND. Ver docs-site/deploy notes.

const BACKEND = () => (process.env.KB_EMBED_BACKEND || 'local').toLowerCase();

// ---- backend local (transformers.js) ----
const LOCAL_MODEL = () => process.env.KB_EMBED_MODEL_LOCAL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
let _pipe = null;
async function localPipe() {
  if (!_pipe) {
    const { pipeline } = await import('@huggingface/transformers');
    _pipe = await pipeline('feature-extraction', LOCAL_MODEL());
  }
  return _pipe;
}
async function embedLocal(batch) {
  const ext = await localPipe();
  const out = await ext(batch, { pooling: 'mean', normalize: true });
  return out.tolist();                                   // [n][dim]
}

// ---- backend ollama ----
const OLLAMA = () => (process.env.OLLAMA_URL || 'http://100.126.196.112:11434').replace(/\/$/, '');
const OLLAMA_MODEL = () => process.env.KB_EMBED_MODEL || 'all-minilm';
async function embedOllama(batch, url = OLLAMA(), model = OLLAMA_MODEL()) {
  const r = await fetch(`${url}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: batch }),
  });
  if (r.ok) {
    const j = await r.json();
    const vecs = j.embeddings || (j.embedding ? [j.embedding] : []);
    if (vecs.length) return vecs;
  }
  const out = [];                                        // fallback /api/embeddings (por-texto)
  for (const prompt of batch) {
    const rr = await fetch(`${url}/api/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt }),
    });
    if (!rr.ok) throw new Error(`ollama embeddings HTTP ${rr.status}`);
    out.push((await rr.json()).embedding);
  }
  return out;
}

export async function embed(input) {
  const batch = Array.isArray(input) ? input : [input];
  const vecs = BACKEND() === 'ollama' ? await embedOllama(batch) : await embedLocal(batch);
  return Array.isArray(input) ? vecs : vecs[0];
}
