// Utilitários de texto para o RAG: HTML→texto e chunking por parágrafos.

export const htmlToText = (html) =>
  String(html)
    .replace(/<(\/p|\/h[1-6]|\/li|\/tr|\/div|br\s*\/?)>/gi, '\n')  // limites de bloco → newline
    .replace(/<[^>]+>/g, ' ')                                       // restantes tags
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();

// Agrupa parágrafos em passagens de ~`max` chars (respeitando fronteiras), com `min` de piso.
export function chunk(text, { max = 1100, min = 300 } = {}) {
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    const candidate = cur ? cur + '\n\n' + p : p;
    if (candidate.length > max && cur.length >= min) { out.push(cur); cur = p; }
    else cur = candidate;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
