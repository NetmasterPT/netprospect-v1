// Wrapper para o timer `wordfence-update` correr o updater DENTRO de um worker (que tem MINIO_* +
// WORDFENCE_API_KEY + lib) SEM depender do update-wordfence.js baked na imagem — as imagens em execução
// são antigas e não o têm. `worker/` é volume-mounted → este ficheiro chega à frota sem rebuild.
// No-op limpo (exit 0) se a WORDFENCE_API_KEY faltar; ver lib/wordfence.js.
import { updateWordfenceDb } from '../lib/wordfence.js';
updateWordfenceDb()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[wordfence]', e?.message || e); process.exit(1); });
