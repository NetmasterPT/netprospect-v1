// lib/email-junk.js — filtro central de emails-lixo para a extração de contactos.
// Junta o que estava disperso em contacts.js/fingerprints.js e acrescenta duas
// classes que estavam a poluir os dados (descoberto no audit de qualidade):
//   1) SUPORTE DE PROVIDERS de hosting/site-builder (support@loopia.se aparecia em
//      417 sites de clientes deles) — não são leads, são o rodapé legal do provider.
//   2) PLACEHOLDERS/exemplos (etunimi.sukunimi@esimerkki.fi = "firstname.surname@
//      example.fi", matti.meikalainen, max.mustermann, john.doe, anna.andersson…).
//   3) Terceiros genéricos (dpo-google@google.com, @facebook.com, @shopify.com…).
//   4) RUN-ON do TLD: o EMAIL_RE dos extractores captura texto colado a seguir ao TLD (page-builder
//      JSON sem separador) → "x@domain.pthttp", "x@aemachadodematos.ptassistente". O sufixo não é um
//      TLD real; tldts.parse(domain).isIcann distingue (pt/no/nl/com=true; pthttp/ptassistente=false).

import { parse } from 'tldts';

// Padrões no email inteiro (local + domínio). Mantém os antigos + acrescenta placeholders.
const JUNK_RE = new RegExp([
  'example', 'exemplo', 'esimerkki', 'ejemplo', 'beispiel', // "exemplo" em várias línguas
  'placeholder', 'yourdomain', 'yourname', 'your-?name', 'your-?company', 'mysite', 'meusite',
  'meudominio', 'seusite', 'seuemail', 'sitename', 'dummy', '\\bteste?@', 'test@', 'user@', 'name@',
  'nome@', 'you@', 'o\\.?seu@', '^seu@', 'your@', 'email@',
  // placeholders de nome "primeiro.último" em PT/EN/DE/FI/SE/NO:
  'firstname', 'lastname', 'first\\.last', 'john\\.doe', 'jane\\.doe', 'nome\\.apelido',
  'primeiro\\.ultimo', 'etunimi', 'sukunimi', 'mustermann', 'meikalainen', 'meikäläinen',
  'nordmann', 'fornavn', 'etternavn', 'fornamn', 'efternamn', 'anna\\.andersson', 'kalle\\.anka',
  // ruído técnico:
  'sentry', 'wixpress', 'godaddy', '@2x', 'domain\\.com', '@email\\.com', '@fruits\\.co',
  '@company\\.com', '@yourcompany', '\\.(png|jpe?g|gif|svg|webp|ico|css|js)$',
  // domínios de DEMO de temas/templates (nunca são a empresa real):
  'demolink', 'templatemonster', 'template-?help', 'themeforest', '@demo\\.', 'demo@',
].join('|'), 'i');

// Domínios de PROVIDERS/plataformas + terceiros — qualquer email @ estes é lixo
// (o suporte do provider, não um contacto da empresa). Match por sufixo de domínio.
const PROVIDER_DOMAINS = [
  'loopia.se', 'loopia.no', 'loopia.com', 'loopia.rs', 'loopiagroup.com', 'webador.com', 'webador.co.uk',
  'active24.com', 'active24.se', 'active24.nl', 'active24.co.uk', 'active24.cz', 'one.com', 'oderland.se',
  'wix.com', 'wixpress.com', 'shopify.com', 'squarespace.com', 'godaddy.com', 'hostinger.com',
  'ionos.com', '1and1.com', 'ovh.com', 'ovh.net', 'gandi.net', 'namecheap.com', 'bluehost.com',
  'siteground.com', 'dreamhost.com', 'readymag.com', 'weebly.com', 'jimdo.com', 'strikingly.com',
  'carrd.co', 'webnode.com', 'simplesite.com', 'mozello.com', 'site123.com', 'starapps.studio',
  'weunite.club', 'sharefox.no', 'confetti.events',
  // builders/registrars NL/SE/NO apanhados no audit 2026-07-19 (o email é da PLATAFORMA, não da empresa):
  'jouwweb.nl', 'minhemsida.se', 'domein.nl', 'mono.net', 'yola.com', 'e-monsite.com', 'wixsite.com', 'my.website',
  // terceiros genéricos (privacidade/plataforma, nunca leads):
  'google.com', 'gstatic.com', 'facebook.com', 'fb.com', 'instagram.com', 'shopifyemail.com',
  'sentry.io', 'cloudflare.com', 'mailchimp.com', 'sendgrid.net',
];
const PROVIDER_SET = new Set(PROVIDER_DOMAINS);

export function isJunkEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e.includes('@')) return true;
  if (JUNK_RE.test(e)) return true;
  const domain = e.split('@')[1] || '';
  // RUN-ON do TLD (classe 4): sufixo não-ICANN = texto colado depois do TLD real → email inválido.
  let p; try { p = parse(domain); } catch { return true; }
  if (!p || !p.isIcann || !p.domain) return true;
  // RUN-ON de LOCAL-PART (classe 5): texto/URL colado ANTES do @ (page-builder sem separador) — um
  // local-part real não tem "www.", um TLD embutido, "screenshot"/data, nem é enorme. Ex.:
  // "www.b-training.ptgeral@…", "mobiliario-…-www.baltexport.pt-geral@…", "screenshot-2025-…-@…".
  const local = e.split('@')[0] || '';
  // `www.` + gTLDs genéricos (raros em nomes). NÃO country-codes (.de/.no/.se… aparecem em nomes
  // holandeses/nórdicos: "rob.de.oase", "petanque.no" — davam falsos-positivos).
  if (/www\.|\.(com|org|net)(?![a-z])/.test(local)) return true;
  if (/screenshot|\b\d{4}-\d{2}-\d{2}\b|-at-\d/.test(local)) return true;
  if (local.length > 45) return true;
  if (PROVIDER_SET.has(domain)) return true;
  // sufixo (ex.: mail.loopia.se) para os principais providers
  for (const p of PROVIDER_SET) if (domain === p || domain.endsWith('.' + p)) return true;
  return false;
}

export { PROVIDER_DOMAINS };
