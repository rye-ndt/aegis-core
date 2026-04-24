FROM node:20.19-alpine3.21 AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev && \
    find node_modules -type f \( -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.map" -o -name "*.md" -o -name "LICENSE" -o -name "LICENCE" -o -name "CHANGELOG*" -o -name "*.txt" \) -delete && \
    find node_modules -type d \( -name "test" -o -name "tests" -o -name "__tests__" -o -name ".github" \) -exec rm -rf {} + 2>/dev/null || true

FROM node:20.19-alpine3.21 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
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
  HTTP_API_PORT=${PORT:-8080}; \
  case \"${PROCESS_ROLE:-combined}\" in \
    worker)   exec node dist/workerCli.js ;; \
    http)     exec node dist/httpCli.js ;; \
    combined) exec node dist/telegramCli.js ;; \
    *)        echo \"unknown PROCESS_ROLE=$PROCESS_ROLE\" && exit 1 ;; \
  esac \
"]
