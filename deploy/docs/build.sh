#!/usr/bin/env bash
# Reconstrói o site de docs (docs-site/dist) a partir do vault docs/.
# Corre num CONTAINER node porque o host (np-server) NÃO tem node — só docker. O onnxruntime
# fica compatível (build no mesmo linux-x64/glibc). O docs-web (nginx) serve o dist novo (bind-mount).
# Chamado via systemd timer após o git pull. Necessário porque a guarda do pull-deploy.sh não recria
# containers em commits só-.md — mas o site TEM de ser reconstruído quando docs/ muda.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker run --rm -v "$REPO":/app -w /app/docs-site node:20-slim \
  sh -c "npm install --no-audit --no-fund 2>&1 | tail -2 && npm run build 2>&1 | grep -iE 'páginas|built|error' | tail -5"
echo "docs rebuild OK: $(date -Is)"
