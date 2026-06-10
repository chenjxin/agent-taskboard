# Agent Task Board — multi-stage build.
#
# Base image choice: node:24-bookworm-slim (glibc). better-sqlite3 ^12 ships
# prebuilt glibc binaries for Node 24, so `npm ci` installs without node-gyp
# (no python/make/g++ needed). Do NOT switch to alpine (musl) without adding
# a full build toolchain.

# ---- build stage ----------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY adoption ./adoption
# build = tsc -p tsconfig.build.json + copy schema.sql, web pages, adoption kit into dist/
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# /data holds board.db plus its WAL siblings (-wal/-shm); owned by the
# unprivileged node user the container runs as.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8765/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
