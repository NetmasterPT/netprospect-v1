// lib/audit/social.js
// Extrai o primeiro perfil "real" de cada rede social do HTML (homepage + páginas de
// contacto). Exclui links de partilha/intent/plugins (share, sharer, intent, ...), que
// não são a presença da empresa mas sim botões de partilha.
//
// Redes: facebook, instagram, linkedin, twitter/x, youtube, tiktok, pinterest, whatsapp.
// WhatsApp é sinal ALTA-prioridade para PMEs (PT): capturamos presença + número.

// A classe do handle é só carateres de path/handle ([a-z0-9%._/-]), limitada a 120.
// Parar em &/]/}/",'/etc. evita apanhar o JSON codificado (&quot;…) dos page-builders
// como parte do URL (senão o handle vinha com "&quot;]}…" colado).
const PATTERNS = {
  facebook: /(?:https?:)?\/\/(?:www\.|m\.|[a-z-]+\.)?facebook\.com\/([a-z0-9%._/-]{1,120})/gi,
  instagram: /(?:https?:)?\/\/(?:www\.)?instagram\.com\/([a-z0-9%._/-]{1,120})/gi,
  linkedin: /(?:https?:)?\/\/(?:[a-z]+\.)?linkedin\.com\/(company|in|school|pub)\/([a-z0-9%._/-]{1,120})/gi,
  twitter: /(?:https?:)?\/\/(?:www\.)?(?:twitter|x)\.com\/([a-z0-9%._/-]{1,120})/gi,
  // YouTube: só perfis de canal (@handle, /channel/, /c/, /user/) — nunca /watch, /embed, /shorts.
  youtube: /(?:https?:)?\/\/(?:www\.)?youtube\.com\/((?:@|channel\/|c\/|user\/)[a-z0-9%._-]{1,80})/gi,
  // TikTok: só @handle.
  tiktok: /(?:https?:)?\/\/(?:www\.)?tiktok\.com\/(@[a-z0-9%._-]{1,80})/gi,
  // Pinterest: perfil (qualquer TLD: .com/.pt/.es/…). Exclui /pin/ /search/ /ideas/.
  pinterest: /(?:https?:)?\/\/(?:[a-z]{2,3}\.)?pinterest\.[a-z.]{2,6}\/([a-z0-9%._/-]{1,80})/gi,
};

// Handles/segmentos que indicam um botão de partilha ou página utilitária, não um perfil.
const EXCLUDE = {
  facebook: /^(sharer|share\.php|dialog\/|plugins\/|tr\/?$|login|help|policies|events\/|watch\/|hashtag\/|profile\.php$)/i,
  // NÃO excluir /explore/locations/ (página de localização de negócio = presença real).
  instagram: /^(p\/|reel\/|explore\/(?!locations)|accounts\/|share|stories\/|about\/|directory\/)/i,
  linkedin: /(sharing|sharearticle|share-offsite|shareactive|\/share)/i,
  twitter: /^(intent|share|home|hashtag|search|i\/|privacy|tos|about|login|explore)/i,
  youtube: /^(watch|embed|results|shorts|playlist|feed|hashtag)\b/i,
  tiktok: /^(tag|search|discover|foryou|explore|about|legal)\b/i,
  pinterest: /^(pin\/|search\/|ideas\/|categories\/|today\/|_created)/i,
};

function normalize(u) {
  let s = u.replace(/^\/\//, 'https://').replace(/^http:/, 'https:');
  s = s.replace(/[)\].,;'"]+$/, '').replace(/\/+$/, '');
  return s.slice(0, 255);
}

const MAX_PER_NET = 12;

// WhatsApp: wa.me/<num>, api|web.whatsapp.com/send?phone=<num>, whatsapp://send?phone=<num>,
// chat.whatsapp.com/<invite>. Devolve { urls:[...], number:'+…'|null }.
const WA_URL_RE = /(?:https?:)?\/\/(?:api\.|web\.|chat\.)?(?:whatsapp\.com|wa\.me)\/([^\s"'<>)]{1,160})/gi;
const WA_APP_RE = /whatsapp:\/\/send\/?\?phone=(\d{6,15})/gi;
function extractWhatsapp(html) {
  const urls = [];
  const seen = new Set();
  let number = null;
  const addUrl = (raw) => { const u = normalize(raw); const k = u.toLowerCase(); if (!seen.has(k)) { seen.add(k); urls.push(u); } };
  let m;
  WA_URL_RE.lastIndex = 0;
  while ((m = WA_URL_RE.exec(html)) && urls.length < MAX_PER_NET) {
    const full = m[0];
    if (/whatsapp\.com\/(?:privacy|legal|about|download|business\/?$|contact)/i.test(full)) continue; // páginas do próprio WhatsApp
    addUrl(full);
    if (!number) { const d = (m[1].match(/\d{6,15}/) || [])[0]; if (d) number = (d.length >= 9 ? '+' : '') + d; }
  }
  WA_APP_RE.lastIndex = 0;
  while ((m = WA_APP_RE.exec(html))) { addUrl(m[0]); if (!number) number = '+' + m[1]; }
  return { urls, number };
}

// Devolve { facebook, instagram, linkedin, twitter, youtube, tiktok, pinterest, whatsapp }
// com um ARRAY de URLs de cada rede (todos os perfis reais, deduplicados) + whatsapp_number.
export function extractSocial(html) {
  const res = { facebook: [], instagram: [], linkedin: [], twitter: [], youtube: [], tiktok: [], pinterest: [], whatsapp: [], whatsapp_number: null };
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
  const wa = extractWhatsapp(html);
  res.whatsapp = wa.urls;
  res.whatsapp_number = wa.number;
  return res;
}

// Flags booleanas "tem ≥1 perfil" (a partir do resultado de extractSocial).
export function socialFlags(social) {
  const s = social || {};
  const has = (n) => Array.isArray(s[n]) ? s[n].length > 0 : !!s[n]; // tolera shape antigo
  return {
    facebook: has('facebook'), instagram: has('instagram'), linkedin: has('linkedin'), twitter: has('twitter'),
    youtube: has('youtube'), tiktok: has('tiktok'), pinterest: has('pinterest'), whatsapp: has('whatsapp'),
  };
}
