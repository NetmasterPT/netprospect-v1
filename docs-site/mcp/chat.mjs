// Chat de docs: RAG federado (searchDocs) → resposta. FONTES (rag/rag-only/graphify/context-mode) × MODELOS
// (retrieval sem-IA · ollama local · cloud OpenAI-compat: gemini/openai/grok/openrouter · anthropic: claude).
// Os modelos cloud só ficam available se a env-key respetiva existir. Observabilidade $ai_generation → PostHog.
import { searchDocs, getDoc, listRelated } from './tools.mjs';
import { ollamaStream, ollamaEnabled, ollamaModel } from '../../lib/ollama.js';
import { cliChatProviders, cliStream, cliList } from './cli-providers.mjs';

const OLLAMA_ON = () => !['0', 'false', 'off'].includes(String(process.env.DOCS_OLLAMA_ENABLED || '').toLowerCase()) && ollamaEnabled();
const clip = (s, n = 700) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// deteção de keys/tokens cloud (env)
const KEY = {
  gemini: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  claude: () => process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
  openai: () => process.env.OPENAI_API_KEY,
  grok: () => process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  openrouter: () => process.env.OPENROUTER_API_KEY,
};
const CLOUD = {
  gemini: { label: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: () => process.env.GEMINI_MODEL || 'gemini-1.5-flash' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: () => process.env.OPENAI_MODEL || 'gpt-4o-mini' },
  grok: { label: 'Grok', base: 'https://api.x.ai/v1', model: () => process.env.GROK_MODEL || 'grok-2-latest' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: () => process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini' },
  claude: { label: 'Claude', anthropic: true, model: () => process.env.CLAUDE_MODEL || 'claude-3-5-haiku-latest' },
};

export function chatProviders() {
  return {
    sources: [
      { id: 'rag', label: 'RAG + adições', available: true },
      { id: 'rag-only', label: 'Só RAG', available: true },
      { id: 'graphify', label: 'Só Graphify', available: true },
      { id: 'context-mode', label: 'Só Context Mode', available: true },
    ],
    models: [
      { id: 'retrieval', label: 'Sem IA · extractos', kind: 'retrieval', available: true },
      { id: 'ollama', label: `Ollama · ${ollamaModel()}`, kind: 'local', available: OLLAMA_ON() },
      ...Object.entries(CLOUD).map(([id, m]) => ({ id, label: m.label, kind: 'cloud', available: !!KEY[id]() })),
      ...cliChatProviders(),   // CLIs em Docker (F2) — available se houver auth (key/subscrição)
    ],
  };
}
export const defaultModel = () => (OLLAMA_ON() ? 'ollama' : 'retrieval');

// RETRIEVE conforme a fonte. rag = vetorial + vizinhos do top hit (adições); rag-only/context-mode = vetorial;
// graphify = arranca no top vetorial e expande pelos vizinhos do grafo.
async function retrieve(query, source, profile) {
  const hits = await searchDocs(query, 6, profile);
  if (source === 'graphify' && hits[0]) {
    const seed = hits[0];
    const nb = listRelated(seed.slug).slice(0, 6);
    const extra = nb.map((n) => { const d = getDoc(n.slug); return d && { slug: d.slug, title: d.title, type: d.type, module: null, score: 0, text: d.text }; }).filter(Boolean);
    return dedup([seed, ...extra]);
  }
  if (source === 'rag') {
    const nb = hits[0] ? listRelated(hits[0].slug).slice(0, 3) : [];
    const extra = nb.map((n) => { const d = getDoc(n.slug); return d && { slug: d.slug, title: d.title, type: d.type, module: null, score: 0, text: d.text }; }).filter(Boolean);
    return dedup([...hits, ...extra]);
  }
  return hits; // rag-only, context-mode
}
const dedup = (arr) => { const s = new Set(), out = []; for (const h of arr) if (!s.has(h.slug)) { s.add(h.slug); out.push(h); } return out.slice(0, 8); };

const buildPrompt = (query, hits) => {
  const ctx = hits.map((h, i) => `[${i + 1}] (${h.module || h.type} · ${h.slug})\n${clip(h.text, 900)}`).join('\n\n');
  return `És o assistente de documentação do NetProspect. Responde à pergunta usando APENAS o contexto abaixo `
    + `(docs internos). Cita as fontes como [n]. Se o contexto não responder, di-lo. Responde em português.\n\n`
    + `### Contexto\n${ctx}\n\n### Pergunta\n${query}\n\n### Resposta (com citações [n]):`;
};

// ---- streaming cloud ----
async function openaiCompatStream({ base, key, model, prompt, onToken, extraHeaders = {} }) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok || !r.body) return { ok: false, error: `HTTP ${r.status}` };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if (d === '[DONE]') continue;
      try { const j = JSON.parse(d); const t = j.choices?.[0]?.delta?.content; if (t) { text += t; onToken && onToken(t); } } catch {}
    }
  }
  return { ok: true, text };
}
async function anthropicStream({ key, model, prompt, onToken }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok || !r.body) return { ok: false, error: `HTTP ${r.status}` };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5).trim()); if (j.type === 'content_block_delta' && j.delta?.text) { text += j.delta.text; onToken && onToken(j.delta.text); } } catch {}
    }
  }
  return { ok: true, text };
}

async function captureAi({ distinctId, provider, model, latencyMs, ok, input, output }) {
  const key = process.env.POSTHOG_PUBLIC_KEY; if (!key) return;
  const host = (process.env.POSTHOG_PUBLIC_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');
  try {
    await fetch(`${host}/capture/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, event: '$ai_generation', distinct_id: distinctId || 'docs-chat',
        properties: { $ai_provider: provider, $ai_model: model, $ai_latency: latencyMs / 1000, $ai_is_error: !ok, $ai_input: clip(input, 400), $ai_output_choices: [clip(output, 800)], app_name: 'docs' } }) });
  } catch {}
}

// Executa o chat. onCite(cites[]) 1×; onToken(str) por token.
export async function answer({ query, source = 'rag', model, profile, distinctId, onToken, onCite } = {}) {
  const hits = await retrieve(query, source, profile);
  const cites = hits.map((h, i) => ({ n: i + 1, slug: h.slug, title: h.title, module: h.module || h.type, score: h.score }));
  if (onCite) onCite(cites);
  const chosen = model || defaultModel();

  if (chosen === 'retrieval') {
    const text = hits.length ? hits.map((h, i) => `[${i + 1}] ${h.title} — ${clip(h.text, 240)}`).join('\n\n') : 'Sem resultados nos módulos ativos.';
    if (onToken) onToken(text);
    return { provider: 'retrieval', model: null, source, text, cites };
  }
  if (chosen === 'ollama') {
    if (!OLLAMA_ON()) return failMsg(onToken, 'ollama', cites, source, 'Ollama desligado (OLLAMA_URL/flag).');
    const m = ollamaModel(); const t0 = Date.now();
    const r = await ollamaStream(buildPrompt(query, hits), { model: m, onToken });
    captureAi({ distinctId, provider: 'ollama', model: m, latencyMs: Date.now() - t0, ok: r.ok, input: query, output: r.text });
    return { provider: 'ollama', model: m, source, text: r.text, cites, error: r.error };
  }
  // CLI-em-Docker (F2): se o modelo escolhido é um CLI provider
  if (cliList().some((p) => p.id === chosen)) {
    const t0 = Date.now();
    const r = await cliStream({ provider: chosen, prompt: buildPrompt(query, hits), onToken });
    captureAi({ distinctId, provider: chosen, model: chosen, latencyMs: Date.now() - t0, ok: r.ok, input: query, output: r.text });
    if (!r.ok && onToken) onToken(`⚠️ ${chosen}: ${r.error}`);
    return { provider: chosen, model: chosen, source, text: r.text, cites, error: r.error };
  }
  const cfg = CLOUD[chosen];
  if (!cfg) return failMsg(onToken, chosen, cites, source, `Modelo desconhecido: ${chosen}.`);
  const key = KEY[chosen]();
  if (!key) return failMsg(onToken, chosen, cites, source, `${cfg.label}: adiciona a API key/token para ativar (Fase 2).`);
  const m = cfg.model(); const prompt = buildPrompt(query, hits); const t0 = Date.now();
  const r = cfg.anthropic
    ? await anthropicStream({ key, model: m, prompt, onToken })
    : await openaiCompatStream({ base: cfg.base, key, model: m, prompt, onToken, extraHeaders: chosen === 'openrouter' ? { 'HTTP-Referer': 'https://netprospect.netmaster.pt', 'X-Title': 'NetProspect Docs' } : {} });
  captureAi({ distinctId, provider: chosen, model: m, latencyMs: Date.now() - t0, ok: r.ok, input: query, output: r.text });
  if (!r.ok && onToken) onToken(`⚠️ ${cfg.label}: ${r.error}`);
  return { provider: chosen, model: m, source, text: r.text, cites, error: r.error };
}
function failMsg(onToken, provider, cites, source, msg) {
  if (onToken) onToken(`⚠️ ${msg}`);
  return { provider, model: null, source, text: msg, cites, error: msg };
}
