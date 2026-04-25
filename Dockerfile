# ── base: shared OS build tools (cached until apk command changes) ────────────
FROM node:20.19-alpine3.21 AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

# ── deps: clean production-only node_modules ─────────────────────────────────
# Cached as long as package-lock.json doesn't change.
# Fresh npm ci --omit=dev avoids prune artifacts (e.g. typescript leaking in).
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && \
    rm -rf node_modules/typescript node_modules/@simplewebauthn/typescript-types && \
    find node_modules -type f \( -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.map" -o -name "*.md" -o -name "LICENSE" -o -name "LICENCE" -o -name "CHANGELOG*" -o -name "*.txt" \) -delete && \
    find node_modules -type d \( -name "__tests__" -o -name ".github" \) -exec rm -rf {} + 2>/dev/null || true

# ── builder: full deps + compile ──────────────────────────────────────────────
# npm ci layer is cached when lock file is unchanged; only tsc reruns on src changes.
FROM base AS builder
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

# ── runtime: lean final image ─────────────────────────────────────────────────
FROM node:20.19-alpine3.21 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

# Cloud Run injects PORT; remap to HTTP_API_PORT which the app reads.
EXPOSE 8080

USER node

# Role is chosen at deploy time by setting PROCESS_ROLE.
# Worker:  PROCESS_ROLE=worker → runs dist/workerCli.js
# HTTP:    PROCESS_ROLE=http   → runs dist/httpCli.js
# Unset:   legacy combined     → runs dist/telegramCli.js
CMD ["sh", "-c", "\
  export HTTP_API_PORT=${PORT:-8080}; \
  node dist/migrate.js && \
  case \"${PROCESS_ROLE:-combined}\" in \
    worker)   exec node dist/workerCli.js ;; \
    http)     exec node dist/httpCli.js ;; \
    combined) exec node dist/telegramCli.js ;; \
    *)        echo \"unknown PROCESS_ROLE=$PROCESS_ROLE\" && exit 1 ;; \
  esac \
"]
