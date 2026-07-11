# Worker da pipeline NetProspect.
# Contexto de build = raiz do repo (docker-compose: context .. / dockerfile
# worker/Dockerfile) para copiar o código partilhado (lib/, *.js).
#
# Inclui a toolchain das auditorias pesadas (Fase 2b): Chromium (Lighthouse+GMB),
# Nuclei (segurança batch) e WPScan (on-demand). Só são USADOS quando
# AUDIT_ENABLED=true; caso contrário a imagem só corre enrich+contactos.
FROM node:22-bookworm-slim

WORKDIR /app

# --- Sistema: Chromium + Ruby (WPScan) + utilitários de download ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji \
      ca-certificates curl unzip procps \
      ruby ruby-dev build-essential libcurl4-openssl-dev libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# --- Node deps (inclui lighthouse/chrome-launcher/puppeteer-core) ---
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- WPScan (gem) — só usado on-demand ---
RUN gem install wpscan --no-document

# --- Nuclei (última release) + templates (~83MB, ficam em /root/nuclei-templates) ---
RUN NUCLEI_VER=$(curl -sL https://api.github.com/repos/projectdiscovery/nuclei/releases/latest | grep -Po '"tag_name":\s*"v\K[0-9.]+') \
    && curl -sL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VER}/nuclei_${NUCLEI_VER}_linux_amd64.zip" -o /tmp/nuclei.zip \
    && unzip -o /tmp/nuclei.zip -d /usr/local/bin nuclei && rm /tmp/nuclei.zip \
    && nuclei -version \
    && nuclei -update-templates

# --- Código ---
COPY lib ./lib
COPY worker ./worker
COPY enrich-sites.js extract-contacts.js update-geoip.js ./
COPY config ./config

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    NUCLEI_BIN=nuclei
# GeoIP + Tranco vêm por bind-mount (ro): /app/data/{geoip,tranco}.
CMD ["node", "worker/worker.mjs"]
