// fetch-tranco.js
// Baixa a lista Tranco top-1M para data/tranco/top-1m.csv (proxy de tráfego).
// Só refaz se estiver em falta ou com mais de 30 dias. Corre no host; o CSV é
// bind-montado nos workers (RO). Uso: node fetch-tranco.js [--force]

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';

const DIR = 'data/tranco';
const CSV = path.join(DIR, 'top-1m.csv');
const ZIP = path.join(DIR, 'top-1m.csv.zip');
const URL = 'https://tranco-list.eu/top-1m.csv.zip';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FORCE = process.argv.includes('--force');

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!FORCE && fs.existsSync(CSV)) {
    const age = Date.now() - fs.statSync(CSV).mtimeMs;
    if (age < MAX_AGE_MS) { console.log(`Tranco atual (${Math.round(age / 86400000)}d) — nada a fazer.`); return; }
  }
  console.log(`A descarregar ${URL} …`);
  const r = await fetch(URL, { headers: { 'User-Agent': 'netprospect/1.0' } });
  if (!r.ok) throw new Error(`Tranco HTTP ${r.status}`);
  fs.writeFileSync(ZIP, Buffer.from(await r.arrayBuffer()));
  console.log('A descompactar…');
  try {
    execFileSync('unzip', ['-o', ZIP, '-d', DIR], { stdio: 'ignore' });
  } catch {
    // Sem `unzip` no host — usa o python3 (zipfile).
    execFileSync('python3', ['-c', `import zipfile;zipfile.ZipFile(${JSON.stringify(ZIP)}).extractall(${JSON.stringify(DIR)})`], { stdio: 'ignore' });
  }
  try { fs.unlinkSync(ZIP); } catch { /* ignora */ }
  const lines = parseInt(execFileSync('wc', ['-l', CSV]).toString().trim().split(/\s+/)[0], 10) || 0;
  console.log(`Concluído. ${lines} domínios em ${CSV}.`);
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
