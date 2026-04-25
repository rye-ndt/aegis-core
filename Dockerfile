# syntax=docker/dockerfile:1.7

# ── builder: full deps + single esbuild bundle ────────────────────────────────
# Build tools are required because `telegram` (gramJS) pulls in transitive
# `websocket`, which nests its own `utf-8-validate` and runs node-gyp at
# install time. They live in the builder stage only — the runtime image stays
# clean. esbuild is installed pinned for reproducibility — promote to
# devDependencies later if you prefer.
FROM node:20.19-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund && \
    npm i --no-save --no-audit --no-fund esbuild@0.24.0

COPY src ./src

# Single bundle from src/entrypoint.ts. The entrypoint statically requires
# migrate + the three CLIs, so esbuild traces the whole graph once and dedupes
# heavy shared deps (viem, openai, telegram, drizzle-orm).
#
# Externals — packages that misbehave when bundled:
#   pino + thread-stream + sonic-boom + pino-std-serializers
#       worker_threads + dynamic transport require
#   bufferutil, utf-8-validate
#       optional native peers of `ws` (used by viem/telegram websockets)
#   pg-native
#       optional libpq binding for `pg`
#   pg-cloudflare
#       optional `pg` peer for Workers runtime
RUN ./node_modules/.bin/esbuild src/entrypoint.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --outfile=dist/server.js \
      --minify \
      --sourcemap=external \
      --legal-comments=none \
      --keep-names \
      --external:pino \
      --external:thread-stream \
      --external:sonic-boom \
      --external:pino-std-serializers \
      --external:bufferutil \
      --external:utf-8-validate \
      --external:pg-native \
      --external:pg-cloudflare

# Tiny runtime node_modules: copy only the externals' install dirs straight
# out of the already-installed builder modules. No second `npm install`, no
# lockfile gymnastics. Missing optional deps (bufferutil, pg-native, etc.)
# are silently skipped — `ws`/`pg` fall back to JS, which is what we want.
RUN mkdir -p /app/runtime_modules /app/runtime_modules/@pinojs && \
    for pkg in pino thread-stream sonic-boom pino-std-serializers \
               safe-stable-stringify atomic-sleep on-exit-leak-free \
               process-warning quick-format-unescaped real-require \
               pino-abstract-transport split2 \
               bufferutil utf-8-validate node-gyp-build; do \
      if [ -d "node_modules/$pkg" ]; then \
        cp -R "node_modules/$pkg" /app/runtime_modules/; \
      fi; \
    done && \
    if [ -d "node_modules/@pinojs/redact" ]; then \
      cp -R node_modules/@pinojs/redact /app/runtime_modules/@pinojs/; \
    fi

# ── runtime: minimal slim image, no build tools ───────────────────────────────
FROM node:20.19-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/runtime_modules ./node_modules
# Drizzle migration SQL + journal — read at runtime by migrator(migrationsFolder).
COPY drizzle ./drizzle

EXPOSE 8080
USER node

# Role is chosen at deploy time by setting PROCESS_ROLE.
# Worker:    PROCESS_ROLE=worker   → workerCli
# HTTP:      PROCESS_ROLE=http     → httpCli
# Combined:  PROCESS_ROLE unset    → telegramCli (legacy default)
# Migrations run inline before the CLI starts; move to a dedicated Cloud Run
# Job if you want to decouple migration from boot.
CMD ["node", "dist/server.js"]
