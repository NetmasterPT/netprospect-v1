// Identidade de empresa: chave de deduplicação (org_domain).
//
// Objetivo: quando um mesmo dono tem vários domínios (ex: empresa.pt + empresa.com),
// colapsar numa só empresa. Sinal usado: o domínio do email de contacto.
//
// PROBLEMA: emails de template/placeholder (hello@fruits.co, o.seu@email.com)
// contaminam este sinal e causam fusões falsas. Por isso a fusão entre domínios
// diferentes só acontece quando CORROBORADA: o domínio do email é, ele próprio,
// um site conhecido no nosso conjunto (`knownDomains`). Um domínio de template
// nunca está no conjunto, logo nunca funde por engano.
import { getDomain } from 'tldts';

// Webmail gratuito (não identifica uma empresa).
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.es',
  'live.com', 'live.com.pt', 'outlook.com', 'outlook.pt', 'msn.com',
  'yahoo.com', 'yahoo.es', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'email.com', 'zoho.com',
  'protonmail.com', 'proton.me', 'hey.com', 'yandex.com', 'yandex.ru',
  // webmail PT frequentes
  'sapo.pt', 'clix.pt', 'netcabo.pt', 'iol.pt', 'meo.pt', 'mail.pt',
  'portugalmail.pt', 'telepac.pt', 'aeiou.pt', 'oninet.pt',
]);

// Domínios de template/demo comuns (nunca são empresas reais).
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com',
  'fruits.co', 'company.com', 'yourcompany.com', 'sitename.com', 'mysite.com',
  'website.com', 'test.com', 'demo.com',
]);

// Partes locais que denunciam placeholder ("o seu email", "your email", ...).
const PLACEHOLDER_LOCAL = /^(o\.?seu|seu|teu|your|nome|name|email|mail|exemplo|example|user|utilizador|test|demo|sample)$/i;

// Domínio registável do email, se for de negócio (não freemail/placeholder).
export function emailBusinessDomain(email) {
  if (!email || !email.includes('@')) return null;
  const [local, hostRaw] = email.toLowerCase().split('@');
  if (!hostRaw || PLACEHOLDER_LOCAL.test(local)) return null;
  const dom = getDomain(hostRaw.trim());
  if (!dom || FREEMAIL.has(dom) || PLACEHOLDER_DOMAINS.has(dom)) return null;
  return dom;
}

// Chave da empresa para um site.
//   - Por defeito: o domínio registável do próprio site (seguro, sem fusões falsas).
//   - Funde noutro domínio SÓ se o email for de negócio E esse domínio existir
//     no conjunto de sites conhecidos (`knownDomains`).
export function orgDomain(siteDomain, email, knownDomains = null) {
  const own = getDomain(siteDomain) || siteDomain;
  const bd = emailBusinessDomain(email);
  if (bd && bd !== own && knownDomains && knownDomains.has(bd)) return bd;
  return own;
}
