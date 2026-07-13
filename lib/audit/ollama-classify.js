// lib/audit/ollama-classify.js
// Classifica a ÁREA DE ATIVIDADE do negócio via Ollama (Gemma) com saída JSON
// estruturada (`format` = JSON schema) e uma taxonomia PT fixa. Input = título +
// meta description + ~600 chars visíveis. gemma3:4b p/ qualificados/on-demand;
// gemma3:1b (env OLLAMA_MODEL) p/ a cauda longa.

import { ollamaGenerate, ollamaWarmup } from '../ollama.js';

export const TAXONOMY = [
  'restauracao', 'retalho', 'saude', 'construcao', 'imobiliario', 'turismo',
  'juridico', 'contabilidade', 'automovel', 'beleza', 'educacao', 'ti',
  'marketing', 'industria', 'agricultura', 'transportes', 'desporto', 'moda',
  'casa', 'financeiro', 'associacao', 'outros',
];

// Extrai título + meta description + texto visível resumido do HTML.
export function summarizeForClassify(html, { title } = {}) {
  const h = html || '';
  const t = title || (h.match(/<title[^>]*>([^<]{1,180})<\/title>/i)?.[1] || '').trim();
  const desc = (h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)?.[1]
    || h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,300})["']/i)?.[1] || '').trim();
  const visible = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  return { title: t, description: desc, text: visible };
}

// Pré-aquece o modelo (carrega-o para RAM; o 1.º load a frio em CPU é lento).
// Fire-and-forget no arranque do worker; keep_alive mantém-o residente 30m.
export const warmup = (opts = {}) => ollamaWarmup(opts);

// timeoutMs curto de propósito: se o CPU estiver saturado (enrich/backfill a
// correr), a classificação falha depressa e `industry` fica null, sem travar o
// resto da auditoria. Com o CPU livre (auditorias ligadas pós-enrich), 45s chega
// de sobra; se gemma3:4b for lento, usar OLLAMA_MODEL=gemma3:1b.
export async function classifyIndustry(input, { model, timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 150000) } = {}) {
  const content = [input.title, input.description, input.text].filter(Boolean).join('\n').slice(0, 1500);
  if (!content.trim()) return { industry: null, confidence: null };
  const format = {
    type: 'object',
    properties: { industry: { type: 'string', enum: TAXONOMY }, confidence: { type: 'number' } },
    required: ['industry', 'confidence'],
  };
  const prompt = `És um classificador de negócios. Classifica a ÁREA DE ATIVIDADE PRINCIPAL do site numa única categoria da lista. Responde apenas em JSON.\nCategorias válidas: ${TAXONOMY.join(', ')}\n\nConteúdo do site:\n${content}`;
  const { ok, json } = await ollamaGenerate(prompt, { format, model, timeoutMs, options: { temperature: 0 } });
  if (!ok || !json) return { industry: null, confidence: null };
  let industry = String(json.industry || '').toLowerCase();
  if (!TAXONOMY.includes(industry)) industry = 'outros';
  let confidence = Number(json.confidence);
  if (!Number.isFinite(confidence)) confidence = null;
  else if (confidence > 1) confidence = Math.min(1, confidence / 100);
  return { industry, confidence };
}
