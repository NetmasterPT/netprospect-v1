// Wrapper para o timer `wordfence-update` correr o updater DENTRO de um worker (que tem MINIO_* +
// WORDFENCE_API_KEY + lib) SEM depender do update-wordfence.js baked na imagem — as imagens em execução
// são antigas e não o têm. `worker/` é volume-mounted → este ficheiro chega à frota sem rebuild.
// No-op limpo (exit 0) se a WORDFENCE_API_KEY faltar; ver lib/wordfence.js.
import { updateWordfenceDb } from '../lib/wordfence.js';
// Key em falta = no-op LIMPO (exit 0), não erro: o updateWordfenceDb lança sem a key, mas para o timer
// isso é "nada a fazer" (o wpscan keyless continua a enumerar sem vuln-match). Só exit 1 em erro REAL.
if (!process.env.WORDFENCE_API_KEY) {
  console.log('[wordfence] WORDFENCE_API_KEY em falta — no-op (exit 0)');
  process.exit(0);
}
updateWordfenceDb()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[wordfence]', e?.message || e); process.exit(1); });
