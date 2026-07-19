// update-wordfence.js — descarrega a Wordfence Intelligence vuln DB (feed v3) e guarda o índice compacto
// em MinIO (reports/wordfence/index.json.gz). Os workers carregam-no para o match keyless do wpscan.
//
// Corre DENTRO de um worker (tem a env + acesso ao MinIO): agendado a cada WORDFENCE_UPDATE_DAYS via o
// systemd timer deploy/observability/wordfence-update.timer. Precisa de WORDFENCE_API_KEY (registo grátis
// em wordfence.com/products/wordfence-intelligence). Sem a key, sai a avisar (no-op — keyless na mesma).

import { updateWordfenceDb } from './lib/wordfence.js';

(async () => {
  if (!process.env.WORDFENCE_API_KEY) { console.log('[wordfence] WORDFENCE_API_KEY em falta — nada a fazer (o wpscan keyless continua a enumerar sem vuln-match)'); process.exit(0); }
  try {
    const r = await updateWordfenceDb();
    console.log(`[wordfence] índice atualizado em MinIO: ${r.plugins} plugins, ${r.themes} temas, ${r.core} core (${(r.bytes / 1024).toFixed(0)} KB gzip)`);
    process.exit(0);
  } catch (e) { console.error('[wordfence] falha a atualizar:', e.message); process.exit(1); }
})();
