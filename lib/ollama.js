// lib/ollama.js — cliente Ollama PARTILHADO (/api/generate + JSON estruturado +
// timeout + keep_alive). De-duplica o padrão que estava em lib/campaign-ai.js e
// lib/audit/ollama-classify.js; também serve os agentes IA do dashboard.
//
// OLLAMA_URL vazio → desligado: ollamaGenerate devolve { ok:false } e os callers
// caem no fallback. `format` (JSON schema) força saída JSON estruturada. Nunca lança
// por rede/timeout — devolve { ok:false, error }.

const baseUrl = (override) => (override || process.env.OLLAMA_URL || '').replace(/\/$/, '');
export const ollamaEnabled = () => !!baseUrl();
export const ollamaModel = (m) => m || process.env.OLLAMA_MODEL || 'gemma3:4b';

export async function ollamaGenerate(prompt, { format = null, model, timeoutMs = 45000, options = {}, keepAlive = '30m', ollamaUrl } = {}) {
  const url = baseUrl(ollamaUrl);
  if (!url) return { ok: false, text: '', json: null, error: 'ollama desligado (OLLAMA_URL vazio)' };
  const body = { model: ollamaModel(model), prompt, stream: false, keep_alive: keepAlive, options };
  if (format) body.format = format;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) return { ok: false, text: '', json: null, error: `ollama HTTP ${r.status}` };
    const j = await r.json();
    const text = String(j.response ?? '');
    let json = null;
    if (format) { try { json = JSON.parse(text); } catch { /* resposta não-JSON */ } }
    return { ok: true, text, json };
  } catch (e) { return { ok: false, text: '', json: null, error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(to); }
}

// Pré-aquece o modelo (carrega-o p/ RAM; o 1.º load a frio em CPU é lento).
// Fire-and-forget no arranque; keep_alive mantém-o residente.
export async function ollamaWarmup({ model, timeoutMs = 240000 } = {}) {
  const r = await ollamaGenerate('ok', { model, timeoutMs, options: { num_predict: 1 } });
  return r.ok;
}
