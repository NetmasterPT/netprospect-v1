// lib/audit/cpanel.js
// Deteta alojamento cPanel/WHM a partir de sinais que o enrich já tem em mãos
// (PTR, headers, Set-Cookie, URL final). Sinais "fortes" (cookie cpsession, portas
// 2082-2096, PTR de servidor de partilha) confirmam; LiteSpeed sozinho é só um
// indício fraco (muito comum em cPanel mas também fora dele) e não confirma.

const SHARED_HOSTS = /(cpanel|whm|cpcontacts|webhost|server\d+|srv\d+|host\d+|s\d+)\.[a-z0-9.-]*(hostgator|bluehost|namecheap|siteground|a2hosting|hostinger|ipage|inmotion|dreamhost|greengeeks|ptisp|amen|webempresa|ferozo|dinaserver|serving-sys|cpanel)/i;

export function detectCpanel({ ptr = null, headers = {}, setCookies = [], finalUrl = '' } = {}) {
  const strong = [];
  const weak = [];
  const cookieBlob = (setCookies || []).join('; ');
  const server = String(headers.server || headers.Server || '').toLowerCase();

  if (/cpsession|cpanel/i.test(cookieBlob)) strong.push('cookie:cpsession');
  if (/:(2082|2083|2086|2087|2095|2096)\b|\/cpanel(\/|$)|\/whm(\/|$)/i.test(finalUrl)) strong.push('url:cpanel-port');
  if (ptr && (SHARED_HOSTS.test(ptr) || /\b(cpanel|whm)\b/i.test(ptr))) strong.push(`ptr:${ptr}`);
  if (/litespeed/i.test(server)) weak.push('server:litespeed');
  if (/x-cpanel|cpsrvd/i.test(JSON.stringify(headers).toLowerCase())) strong.push('header:cpanel');

  const isCpanel = strong.length > 0;
  return { isCpanel, signal: (strong[0] || weak[0] || null), signals: [...strong, ...weak] };
}
