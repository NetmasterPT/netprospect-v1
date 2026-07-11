// lib/audit/social.js
// Extrai o primeiro perfil "real" de cada rede social do HTML da homepage.
// Exclui links de partilha/intent/plugins (share, sharer, intent, ...), que não
// são a presença da empresa mas sim botões de partilha.

// A classe do handle é só carateres de path/handle ([a-z0-9%._/-]), limitada a 120.
// Parar em &/]/}/",'/etc. evita apanhar o JSON codificado (&quot;…) dos page-builders
// como parte do URL (senão o handle vinha com "&quot;]}…" colado).
const PATTERNS = {
  facebook: /(?:https?:)?\/\/(?:www\.|m\.|[a-z-]+\.)?facebook\.com\/([a-z0-9%._/-]{1,120})/gi,
  instagram: /(?:https?:)?\/\/(?:www\.)?instagram\.com\/([a-z0-9%._/-]{1,120})/gi,
  linkedin: /(?:https?:)?\/\/(?:[a-z]+\.)?linkedin\.com\/(company|in|school|pub)\/([a-z0-9%._/-]{1,120})/gi,
  twitter: /(?:https?:)?\/\/(?:www\.)?(?:twitter|x)\.com\/([a-z0-9%._/-]{1,120})/gi,
};

// Handles/segmentos que indicam um botão de partilha ou página utilitária, não um perfil.
const EXCLUDE = {
  facebook: /^(sharer|share\.php|dialog\/|plugins\/|tr\/?$|login|help|policies|events\/|watch\/|hashtag\/|profile\.php$)/i,
  instagram: /^(p\/|reel\/|explore\/|accounts\/|share|stories\/|about\/|directory\/)/i,
  linkedin: /(sharing|sharearticle|share-offsite|shareactive|\/share)/i,
  twitter: /^(intent|share|home|hashtag|search|i\/|privacy|tos|about|login|explore)/i,
};

function normalize(u) {
  let s = u.replace(/^\/\//, 'https://').replace(/^http:/, 'https:');
  s = s.replace(/[)\].,;'"]+$/, '').replace(/\/+$/, '');
  return s.slice(0, 255);
}

const MAX_PER_NET = 12;

// Devolve { facebook, instagram, linkedin, twitter } com um ARRAY de URLs de cada
// rede (todos os perfis reais encontrados, deduplicados). Antes era só o primeiro.
export function extractSocial(html) {
  const res = { facebook: [], instagram: [], linkedin: [], twitter: [] };
  if (!html) return res;
  for (const [net, re] of Object.entries(PATTERNS)) {
    re.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) && res[net].length < MAX_PER_NET) {
      const tail = net === 'linkedin' ? `${m[1]}/${m[2] || ''}` : m[1] || '';
      const check = net === 'linkedin' ? m[2] || '' : tail;
      if (!check || check === '/' || EXCLUDE[net].test(check)) continue;
      if (/\.(png|jpe?g|gif|svg|css|js|ico)$/i.test(check)) continue;
      const url = normalize(m[0]);
      if (seen.has(url.toLowerCase())) continue;
      seen.add(url.toLowerCase());
      res[net].push(url);
    }
  }
  return res;
}

// Flags booleanas "tem ≥1 perfil" (a partir do resultado de extractSocial).
export function socialFlags(social) {
  const s = social || {};
  const has = (n) => Array.isArray(s[n]) ? s[n].length > 0 : !!s[n]; // tolera shape antigo
  return { facebook: has('facebook'), instagram: has('instagram'), linkedin: has('linkedin'), twitter: has('twitter') };
}
