# ── Stufe 1: Frontend bauen ──────────────────────────────────
FROM node:24-bookworm-slim AS web
WORKDIR /build
# Erst nur die Paketdateien kopieren: solange die sich nicht
# ändern, bleibt die Installationsschicht im Cache.
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── Stufe 2: Server bauen ────────────────────────────────────
FROM node:24-bookworm-slim AS server
WORKDIR /build
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build

# ── Stufe 3: Laufzeit ────────────────────────────────────────
FROM node:24-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=server /build/dist ./dist
COPY server/migrations ./migrations
COPY server/test ./test
COPY --from=web /build/dist ./public
COPY standby/ ./standby/
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
