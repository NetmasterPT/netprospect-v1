// Chat de docs: RAG federado (searchDocs) → resposta. Providers: `retrieval` (extractos, sem IA) e `ollama`
// (gemma3:4b, streaming). Providers externos (CLIs) = Fase 2. Observabilidade $ai_generation p/ PostHog (best-effort).
import { searchDocs } from './tools.mjs';
import { ollamaStream, ollamaEnabled, ollamaModel } from '../../lib/ollama.js';

// Ollama ligado se OLLAMA_URL definido E a flag DOCS_OLLAMA_ENABLED não estiver off.
const OLLAMA_ON = () => !['0', 'false', 'off'].includes(String(process.env.DOCS_OLLAMA_ENABLED || '').toLowerCase()) && ollamaEnabled();
const clip = (s, n = 700) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function chatProviders() {
  return [
    { id: 'retrieval', label: 'Retrieval (sem IA)', available: true },
    { id: 'ollama', label: `Ollama · ${ollamaModel()}`, available: OLLAMA_ON() },
    // Fase 2 (dormente até haver keys): claude-cli, codex-cli, cursor-cli, gemini-cli, grok, deepseek, opencode.
  ];
}
export const defaultProvider = () => (OLLAMA_ON() ? 'ollama' : 'retrieval');

const buildPrompt = (query, hits) => {
  const ctx = hits.map((h, i) => `[${i + 1}] (${h.module} · ${h.slug})\n${clip(h.text, 900)}`).join('\n\n');
  return `És o assistente de documentação do NetProspect. Responde à pergunta usando APENAS o contexto abaixo `
    + `(docs internos). Cita as fontes como [n]. Se o contexto não responder, di-lo claramente. Responde em português.\n\n`
    + `### Contexto\n${ctx}\n\n### Pergunta\n${query}\n\n### Resposta (com citações [n]):`;
};

// PostHog $ai_generation (best-effort, fail-soft) — mesmo shape do dashboard/server.mjs captureAi.
async function captureAi({ distinctId, model, latencyMs, ok, inputTokens, outputTokens, input, output }) {
  const key = process.env.POSTHOG_PUBLIC_KEY; if (!key) return;
  const host = (process.env.POSTHOG_PUBLIC_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');
  try {
    await fetch(`${host}/capture/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key, event: '$ai_generation', distinct_id: distinctId || 'docs-chat',
        properties: {
          $ai_provider: 'ollama', $ai_model: model, $ai_latency: latencyMs / 1000, $ai_is_error: !ok,
          $ai_input_tokens: inputTokens || 0, $ai_output_tokens: outputTokens || 0,
          $ai_input: clip(input, 400), $ai_output_choices: [clip(output, 800)], app_name: 'docs',
        },
      }),
    });
  } catch { /* fail-soft */ }
}

// Executa o chat. onCite(cites[]) chamado 1× após o retrieve; onToken(str) por token (ollama) ou 1× (retrieval).
export async function answer({ query, profile, provider, distinctId, onToken, onCite } = {}) {
  const hits = await searchDocs(query, 6, profile);
  const cites = hits.map((h, i) => ({ n: i + 1, slug: h.slug, title: h.title, module: h.module, score: h.score }));
  if (onCite) onCite(cites);
  const chosen = provider || defaultProvider();
  if (chosen === 'retrieval' || !OLLAMA_ON()) {
    const text = hits.length
      ? hits.map((h, i) => `[${i + 1}] ${h.title} — ${clip(h.text, 240)}`).join('\n\n')
      : 'Sem resultados nos módulos ativos.';
    if (onToken) onToken(text);
    return { provider: 'retrieval', model: null, text, cites };
  }
  const model = ollamaModel();
  const t0 = Date.now();
  const r = await ollamaStream(buildPrompt(query, hits), { model, onToken });
  captureAi({ distinctId, model, latencyMs: Date.now() - t0, ok: r.ok, inputTokens: r.promptTokens, outputTokens: r.outputTokens, input: query, output: r.text });
  return { provider: 'ollama', model, text: r.text, cites, error: r.error };
}
