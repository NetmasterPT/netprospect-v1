// lib/audit/jsonld.js
// Parser best-effort de blocos <script type="application/ld+json"> — usado pelos
// módulos de auditoria barata (localidade, GMB). Achata @graph e objetos aninhados
// para que o consumidor encontre um nó por @type sem descer a árvore à mão.

export function parseJsonLd(html) {
  const out = [];
  if (!html) return out;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      collect(JSON.parse(raw), out, 0);
    } catch {
      /* JSON-LD malformado (comum) — ignora silenciosamente */
    }
  }
  return out;
}

function collect(node, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { for (const n of node) collect(n, out, depth); return; }
  if (typeof node !== 'object') return;
  out.push(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collect(v, out, depth + 1);
  }
}

// @type pode ser string ou array de strings.
export function typesOf(node) {
  const t = node && node['@type'];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string');
}
