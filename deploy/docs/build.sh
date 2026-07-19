#!/usr/bin/env bash
# Reconstrói o site de docs (docs-site/dist) a partir do vault docs/.
# Corre no host que serve o docs-web (np-server), via systemd timer, APÓS o git pull.
# Necessário porque a guarda do pull-deploy.sh NÃO recria containers em commits só-.md — mas o
# site TEM de ser reconstruído quando o conteúdo (docs/) muda. O docs-web (nginx) serve o dist novo.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../docs-site"
npm ci --silent
npm run build                     # gen:api → content → vite build
echo "docs rebuild OK: $(date -Is)  ($(ls -1 dist/assets | wc -l) assets)"
