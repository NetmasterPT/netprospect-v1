#!/usr/bin/env bash
# Constrói as imagens dos CLIs de IA (F2). Corre no host que vai lançar os containers (onde está o kb-http).
# Só constrói as que têm Dockerfile.<id>; as outras (grok/deepseek/opencode) adiciona-se o Dockerfile depois.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
built=0
for f in "$DIR"/Dockerfile.*; do
  [ -e "$f" ] || continue
  id="${f##*/Dockerfile.}"
  echo "==> netprospect/$id:latest"
  docker build -t "netprospect/$id:latest" -f "$f" "$DIR"
  built=$((built+1))
done
echo "✓ $built imagem(ns) construída(s). Põe a env de auth no kb-http e descomenta o socket Docker (ver README)."
