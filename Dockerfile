# syntax=docker/dockerfile:1.7

# ── builder ──────────────────────────────────────────────────────────────────
# node:20-slim (debian) over alpine: matches the runtime libc so any
# bufferutil/utf-8-validate .node binaries we compile here load cleanly there.
#
# Toolchain note: the pinned bufferutil/utf-8-validate versions in our
# package-lock don't ship arm64 prebuilds inside the npm tarball, so
# `node-gyp-build` falls through to a real node-gyp compile. That requires
# python3 + make + g++. The apt cache mounts below preserve the .debs and
# package lists across builds, so the heavy first-time download (cpp-12 +
# libisl23 + libmpfr6, ~250MB on arm64) only happens once per builder cache.
#
# If you're on M1 and the cold install is unbearably slow (~30 min via
# deb.debian.org over Docker Desktop's vpnkit), swap to a closer mirror
# before `apt-get update`, e.g.:
#   sed -i 's|deb.debian.org|ftp.us.debian.org|g' /etc/apt/sources.list.d/debian.sources
FROM node:20.19-slim AS builder
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++

# Layer 1: deps only. `package*.json` change is rare; this layer stays cached
# across the typical "edit src" rebuild. tsconfig.json is intentionally NOT
# copied here — it changes more often than deps and would invalidate `npm ci`.
COPY package.json package-lock.json ./

# `npm ci` is deterministic + faster than `npm install`. BuildKit cache mount
# preserves the npm cache across builds. `--prefer-offline` favors the cache
# mount, so a re-run on the same lockfile barely touches the network.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund && \
    npm i --no-save --no-audit --no-fund esbuild@0.24.0

# Layer 2: runtime node_modules slice. Depends only on what `npm ci` produced,
# so it's cached for every build that doesn't change package-lock.json.
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

# Layer 3: bundle. This is the only layer that runs on the typical hot-path
# rebuild. Set MINIFY=false to skip minification during dev iteration —
# bundle is ~3× larger but esbuild finishes in 1–2 s instead of 5–10 s.
#   docker build --build-arg MINIFY=false -t aegis-core ./be
ARG MINIFY=true
COPY tsconfig.json ./
COPY src ./src

# Externals — packages that misbehave when bundled:
#   pino + thread-stream + sonic-boom + pino-std-serializers
#       worker_threads + dynamic transport require
#   bufferutil, utf-8-validate
#       native peers of `ws`; gramjs/websocket hard-require them, so they
#       MUST exist on disk at runtime (copied above).
#   pg-native, pg-cloudflare
#       optional `pg` peers we don't ship.
#
# No --sourcemap: shipping it doubles image size and there's no sourcemap-
# aware error reporter wired up. Re-add `--sourcemap=external` if you wire
# Sentry/Datadog and copy the .map to that upload step (NOT into runtime).
RUN --mount=type=cache,target=/app/.esbuild-cache \
    MINIFY_FLAG=$([ "$MINIFY" = "true" ] && echo "--minify" || echo "") && \
    ./node_modules/.bin/esbuild src/entrypoint.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --outfile=dist/server.js \
      $MINIFY_FLAG \
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

# ── runtime ──────────────────────────────────────────────────────────────────
# node:20-slim (~80 MB) over distroless (~150 MB) and matches the builder libc
# so the bufferutil/utf-8-validate .node binaries load cleanly. No build tools.
FROM node:20.19-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

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
# Migrations run inline before the CLI starts; move to a dedicated job if you
# want to decouple migration from boot.
CMD ["node", "dist/server.js"]
