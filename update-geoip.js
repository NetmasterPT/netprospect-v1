// update-geoip.js
//
// Descarrega e extrai as bases GeoLite2 gratuitas da MaxMind (ASN + Country)
// para data/geoip/, mas só se estiverem em falta ou com mais de 2 semanas.
//
// Precisa de uma license key gratuita da MaxMind em docker/.env:
//   MAXMIND_LICENSE_KEY=xxxxxxxx
// (Sem key, o enriquecimento usa o fallback Team Cymru — este script é opcional.)
//
// Uso:
//   node update-geoip.js            (atualiza se necessário)
//   node update-geoip.js --force    (força o download)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEO_DIR = path.join(__dirname, 'data', 'geoip');
const EDITIONS = ['GeoLite2-ASN', 'GeoLite2-Country', 'GeoLite2-City'];
const MAX_AGE_DAYS = 14;

loadEnv();

function ageDays(file) {
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / 86_400_000;
  } catch {
    return Infinity; // não existe
  }
}

async function downloadEdition(edition, key) {
  const url =
    `https://download.maxmind.com/app/geoip_download` +
    `?edition_id=${edition}&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${edition}: HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoip-'));
  const tarPath = path.join(tmpDir, `${edition}.tar.gz`);
  fs.writeFileSync(tarPath, buf);
  // Extrai o tarball (contém pasta datada com o .mmdb lá dentro).
  await execFileP('tar', ['-xzf', tarPath, '-C', tmpDir]);

  // Encontra o .mmdb extraído.
  let src = null;
  for (const entry of fs.readdirSync(tmpDir)) {
    const cand = path.join(tmpDir, entry, `${edition}.mmdb`);
    if (fs.existsSync(cand)) { src = cand; break; }
  }
  if (!src) throw new Error(`${edition}: .mmdb não encontrado no tarball`);

  fs.mkdirSync(GEO_DIR, { recursive: true });
  const dest = path.join(GEO_DIR, `${edition}.mmdb`);
  fs.copyFileSync(src, dest);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return dest;
}

// Atualiza as bases se necessário. Devolve { updated, skipped, mode }.
export async function updateGeoIP({ force = false } = {}) {
  const key = process.env.MAXMIND_LICENSE_KEY;
  if (!key) return { updated: [], skipped: EDITIONS, reason: 'sem MAXMIND_LICENSE_KEY' };

  const updated = [];
  const skipped = [];
  for (const edition of EDITIONS) {
    const dest = path.join(GEO_DIR, `${edition}.mmdb`);
    const age = ageDays(dest);
    if (!force && age < MAX_AGE_DAYS) {
      skipped.push(edition);
      continue;
    }
    process.stdout.write(`GeoIP: a descarregar ${edition} (${age === Infinity ? 'em falta' : Math.round(age) + 'd'})... `);
    await downloadEdition(edition, key);
    console.log('ok');
    updated.push(edition);
  }
  return { updated, skipped };
}

// Execução directa via CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  updateGeoIP({ force: process.argv.includes('--force') })
    .then((r) => {
      if (r.reason) console.log(`GeoIP: ${r.reason} — nada a fazer.`);
      else console.log(`GeoIP: atualizados [${r.updated.join(', ') || '—'}], em dia [${r.skipped.join(', ') || '—'}]`);
    })
    .catch((err) => {
      console.error('GeoIP update falhou:', err.message);
      process.exit(1);
    });
}
