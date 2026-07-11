// Inferência de emails por padrão + pré-filtro de verificação (sintaxe, MX,
// role/departamental, disposable, catch-all). Funções puras/rede-baixa; a
// orquestração + probes (Reacher/APIs) ficam em verify-emails.js + lib/verify-core.js.
// (O antigo smtpProbe raw foi retirado — o Reacher/self-hosted faz o handshake SMTP.)
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);

// --- Pré-filtro (barato, corre primeiro, encolhe muito a lista) --------------

// Sintaxe prática (não RFC completa).
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
export const syntaxValid = (email) => typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);

// Caixas de função/departamentais — entregáveis mas não são pessoas.
const ROLE_LOCALS = new Set([
  'info', 'geral', 'general', 'contact', 'contacto', 'contactos', 'suporte', 'support', 'apoio', 'help',
  'vendas', 'sales', 'comercial', 'marketing', 'financeiro', 'accounts', 'billing', 'rh', 'hr',
  'recrutamento', 'jobs', 'careers', 'noreply', 'no-reply', 'newsletter', 'webmaster', 'admin',
  'postmaster', 'office', 'mail', 'hello', 'ola', 'reservas', 'booking', 'loja', 'shop', 'encomendas',
  'dpo', 'rgpd', 'privacy',
]);
export const isRoleLocal = (localOrEmail) => ROLE_LOCALS.has((localOrEmail || '').split('@')[0].toLowerCase());

// Lista de domínios descartáveis (data/disposable-domains.txt, opcional).
let _disposable = null;
function disposableSet() {
  if (_disposable) return _disposable;
  _disposable = new Set();
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', 'data', 'disposable-domains.txt'), 'utf8').split('\n')) {
      const d = line.trim().toLowerCase();
      if (d && !d.startsWith('#')) _disposable.add(d);
    }
  } catch { /* lista opcional */ }
  return _disposable;
}
export const isDisposable = (domain) => disposableSet().has((domain || '').toLowerCase());

// Catch-all: prova um endereço aleatório improvável; se `probeFn` o "aceitar",
// o domínio aceita tudo -> verificação por email individual é inconclusiva.
export async function classifyCatchAll(domain, probeFn) {
  const rnd = `zzq-${Math.random().toString(36).slice(2, 12)}-nouser`;
  try { return await probeFn(`${rnd}@${domain}`); } catch { return false; }
}

const normalize = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();

export function nameTokens(fullName) {
  return normalize(fullName).split(/[\s-]+/).filter((p) => p && !PARTICLES.has(p));
}

// Candidatos de email por padrão, do mais provável para o menos provável.
export function generatePatterns(fullName, domain) {
  const t = nameTokens(fullName);
  if (!t.length) return [];
  const first = t[0];
  const last = t[t.length - 1];
  const fi = first[0];
  const li = last[0];
  const locals = [];
  if (t.length >= 2) {
    locals.push(`${first}.${last}`, `${first}`, `${fi}${last}`, `${first}${last}`, `${fi}.${last}`, `${first}.${li}`, `${first}_${last}`, `${last}.${first}`, `${last}`);
  } else {
    locals.push(first);
  }
  const seen = new Set();
  return locals.filter((l) => l && !seen.has(l) && seen.add(l)).map((l) => `${l}@${domain}`);
}

export async function resolveMx(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).filter(Boolean);
  } catch {
    return [];
  }
}

