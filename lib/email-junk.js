// lib/email-junk.js — filtro central de emails-lixo para a extração de contactos.
// Junta o que estava disperso em contacts.js/fingerprints.js e acrescenta duas
// classes que estavam a poluir os dados (descoberto no audit de qualidade):
//   1) SUPORTE DE PROVIDERS de hosting/site-builder (support@loopia.se aparecia em
//      417 sites de clientes deles) — não são leads, são o rodapé legal do provider.
//   2) PLACEHOLDERS/exemplos (etunimi.sukunimi@esimerkki.fi = "firstname.surname@
//      example.fi", matti.meikalainen, max.mustermann, john.doe, anna.andersson…).
//   3) Terceiros genéricos (dpo-google@google.com, @facebook.com, @shopify.com…).

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
  if (PROVIDER_SET.has(domain)) return true;
  // sufixo (ex.: mail.loopia.se) para os principais providers
  for (const p of PROVIDER_SET) if (domain === p || domain.endsWith('.' + p)) return true;
  return false;
}

export { PROVIDER_DOMAINS };
