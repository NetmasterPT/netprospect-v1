// lib/google-auth.js — JWT de service-account partilhado (domain-wide delegation).
// Uma conta de serviço serve Calendar/Drive/Docs/… via scopes alargáveis. Impersona
// o utilizador-alvo (subject). Fail-soft: googleEnabled() (sem creds → null).
import { loadEnv } from './env.js';
import { JWT } from 'google-auth-library';
loadEnv();

const SA_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL || '';
// .env guarda a PEM com "\n" literais → converter em newlines reais.
const SA_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

export const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/calendar'];
export function googleEnabled() { return Boolean(SA_EMAIL && SA_KEY); }

const cache = new Map();
export function getJWT(userEmail, scopes = DEFAULT_SCOPES) {
  if (!googleEnabled()) return null;
  const key = `${userEmail}|${scopes.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const jwt = new JWT({ email: SA_EMAIL, key: SA_KEY, scopes, subject: userEmail });
  cache.set(key, jwt);
  return jwt;
}
