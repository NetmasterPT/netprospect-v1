FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs tracing.mjs ./
COPY public ./public
EXPOSE 3000
# --import carrega o bootstrap de tracing (OTel) antes do server. Fail-soft (ver tracing.mjs).
CMD ["node", "--import", "./tracing.mjs", "server.mjs"]
