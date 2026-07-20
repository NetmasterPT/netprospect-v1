// Providers de IA que correm um CLI num container Docker por-pedido (F2). Config: config/cli-providers.json.
// `available` = tem auth (API key OU token de subscrição na env). cliStream faz `docker run --rm -i <image> <cmd>`
// e streama o stdout. Dormente até: imagem construída + env de auth no kb-http + socket Docker montado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = process.env.CLI_PROVIDERS_CONFIG || path.resolve(HERE, '../../config/cli-providers.json');
const DOCKER = process.env.DOCKER_BIN || 'docker';
const TIMEOUT = Number(process.env.CLI_TIMEOUT_MS) || 120000;

let _cfg = null;
const cfg = () => (_cfg ||= JSON.parse(fs.readFileSync(CFG, 'utf8')));
export const cliList = () => { try { return cfg().providers || []; } catch { return []; } };

// nomes de env de auth PRESENTES (apiKey + subscription) para um provider
function authEnvs(p) {
  const names = [...(p.auth?.apiKey || []), ...(p.auth?.subscription || [])];
  return names.filter((n) => process.env[n]);
}
export const cliAvailable = (p) => authEnvs(p).length > 0;

export function cliChatProviders() {
  return cliList().map((p) => ({ id: p.id, label: p.label, kind: 'cli', available: cliAvailable(p), quota: p.quota }));
}

// Corre o CLI num container e streama o stdout via onToken. Devolve {ok,text,error}.
export async function cliStream({ provider, prompt, onToken }) {
  const p = cliList().find((x) => x.id === provider);
  if (!p) return { ok: false, text: '', error: 'cli desconhecido' };
  const envs = authEnvs(p);
  if (!envs.length) return { ok: false, text: '', error: `${p.label}: sem auth (API key ou token de subscrição).` };
  const useStdin = (p.promptVia || 'stdin') === 'stdin';
  // `-e NOME` (sem valor) reencaminha a env do processo kb-http para o container.
  const runArgs = ['run', '--rm', '-i', ...envs.flatMap((e) => ['-e', e]), p.image, ...p.cmd];
  if (!useStdin) runArgs.push(prompt);
  return await new Promise((resolve) => {
    let child;
    try { child = spawn(DOCKER, runArgs, { timeout: TIMEOUT }); }
    catch (e) { return resolve({ ok: false, text: '', error: e.message }); }
    let text = '', err = '';
    child.stdout.on('data', (d) => { const s = d.toString(); text += s; if (onToken) { try { onToken(s); } catch {} } });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, text, error: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, text, error: code === 0 ? null : (err.slice(0, 300) || `exit ${code}`) }));
    if (useStdin && child.stdin) { try { child.stdin.write(prompt); child.stdin.end(); } catch {} }
  });
}
