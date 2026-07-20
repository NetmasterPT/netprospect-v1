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

// timeoutMs: default via OLLAMA_TIMEOUT_MS (Ollama em CPU/sem GPU é lento ~100s+/inferência;
// no hel1-ollama define-se OLLAMA_TIMEOUT_MS=150000). Callers podem sobrepor por chamada.
export async function ollamaGenerate(prompt, { format = null, model, timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 45000, options = {}, keepAlive = '30m', ollamaUrl } = {}) {
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

// Versão STREAMING (/api/generate stream:true) — emite tokens via onToken à medida que chegam.
// Devolve { ok, text, promptTokens, outputTokens }. Nunca lança. Para o chat de docs (SSE).
export async function ollamaStream(prompt, { model, onToken, timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000, options = {}, keepAlive = '30m', ollamaUrl } = {}) {
  const url = baseUrl(ollamaUrl);
  if (!url) return { ok: false, text: '', error: 'ollama desligado (OLLAMA_URL vazio)' };
  const body = { model: ollamaModel(model), prompt, stream: true, keep_alive: keepAlive, options };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok || !r.body) return { ok: false, text: '', error: `ollama HTTP ${r.status}` };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', promptTokens = 0, outputTokens = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.response) { text += j.response; if (onToken) { try { onToken(j.response); } catch {} } }
        if (j.done) { promptTokens = j.prompt_eval_count || promptTokens; outputTokens = j.eval_count || outputTokens; }
      }
    }
    return { ok: true, text, promptTokens, outputTokens };
  } catch (e) { return { ok: false, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(to); }
}

// Pré-aquece o modelo (carrega-o p/ RAM; o 1.º load a frio em CPU é lento).
// Fire-and-forget no arranque; keep_alive mantém-o residente.
export async function ollamaWarmup({ model, timeoutMs = 240000 } = {}) {
  const r = await ollamaGenerate('ok', { model, timeoutMs, options: { num_predict: 1 } });
  return r.ok;
}
