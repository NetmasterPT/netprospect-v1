// Fábrica do cliente Directus (SDK v23) autenticado com token estático.
import { createDirectus, rest, staticToken } from '@directus/sdk';
import { loadEnv } from './env.js';

loadEnv();

export const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://localhost:8056';
export const DIRECTUS_TOKEN =
  process.env.DIRECTUS_TOKEN || process.env.DIRECTUS_ADMIN_TOKEN || '';

export function makeClient() {
  if (!DIRECTUS_TOKEN) {
    throw new Error(
      'DIRECTUS_TOKEN (ou DIRECTUS_ADMIN_TOKEN) em falta — preenche docker/.env.'
    );
  }
  return createDirectus(DIRECTUS_URL)
    .with(staticToken(DIRECTUS_TOKEN))
    .with(rest());
}

// Garante que o token estático desejado está atribuído ao admin.
// (O env ADMIN_TOKEN nem sempre é aplicado pelo Directus; fazemos login com
// email/password e gravamos o token no utilizador admin — persistente e idempotente.)
export async function ensureStaticToken() {
  if (!DIRECTUS_TOKEN) throw new Error('DIRECTUS_TOKEN em falta em docker/.env.');
  const ok = await fetch(`${DIRECTUS_URL}/users/me`, {
    headers: { Authorization: `Bearer ${DIRECTUS_TOKEN}` },
  }).then((r) => r.ok).catch(() => false);
  if (ok) return;

  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;
  const login = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Login admin falhou (${login.status}). Verifica DIRECTUS_ADMIN_EMAIL/PASSWORD.`);
  const access = (await login.json()).data.access_token;

  const patch = await fetch(`${DIRECTUS_URL}/users/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
    body: JSON.stringify({ token: DIRECTUS_TOKEN }),
  });
  if (!patch.ok) throw new Error(`Falha ao definir token estático (${patch.status}): ${await patch.text()}`);
  console.log('Token estático do admin definido.');
}
