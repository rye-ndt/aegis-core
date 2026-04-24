# Scaling Phase 2 — Part 4: Cloud Run multi-replica deploy + local parity

> Prerequisites: Phase 2 parts 1 + 2 + 3 merged.
> Behavior change: **none.** Two Cloud Run services (worker + api) replace one, backed by the same Postgres + Upstash Redis.
> This is the part that actually lifts user capacity.

## Architecture target

```
                ┌──────────────────────────────┐
  Telegram ───▶ │ aegis-worker (Cloud Run)     │  min=1 max=1
                │   · grammy long-poll         │
                │   · 4 scheduled jobs         │
                │   · full DI, full Redis      │
                └──────────────┬───────────────┘
                               │ writes pending, sign requests
                               ▼
                       ┌──────────────┐
                       │ Upstash Redis │ ◀── shared across both
                       └──────────────┘
                               ▲
                               │ reads pending, profile cache
                ┌──────────────┴──────────────┐
  Mini-app ───▶ │ aegis-api (Cloud Run)       │  min=2 max=8
                │   · HTTP API only           │
                │   · no jobs, no bot         │
                └─────────────────────────────┘
                               │
                               ▼
                       ┌──────────────┐
                       │  Postgres    │ ◀── managed, both connect
                       └──────────────┘
```

## Step 4.1 — Multi-stage Dockerfile with role-selectable entrypoint

Edit `be/Dockerfile`. Current `CMD` hardcodes `telegramCli`. Make it role-driven:

```dockerfile
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
```

`HTTP_API_PORT=${PORT:-8080}` stays at the top of the shell so Cloud Run's injected `PORT` wires through to the HTTP server.

## Step 4.2 — Cloud Run deploy config

Use two services backed by the same image, different env.

### `aegis-worker`

```
gcloud run deploy aegis-worker \
  --image gcr.io/<project>/aegis:<tag> \
  --region <region> \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 80 \
  --cpu 1 \
  --memory 512Mi \
  --no-cpu-throttling \
  --set-env-vars PROCESS_ROLE=worker \
  --set-secrets "DATABASE_URL=aegis-db-url:latest,REDIS_URL=aegis-redis-url:latest,TELEGRAM_BOT_TOKEN=aegis-tg-token:latest,OPENAI_API_KEY=aegis-openai-key:latest,PRIVY_APP_SECRET=aegis-privy-secret:latest"
```

Critical:
- `min=1, max=1`. Running > 1 worker duplicates Telegram notifications and scheduled-job side effects.
- `--no-cpu-throttling` — worker runs long-poll and periodic jobs; it must keep CPU outside request cycles.
- `--concurrency 80` — inbound HTTP is not this service's job, but grammy's poll benefits from not being throttled.

### `aegis-api`

```
gcloud run deploy aegis-api \
  --image gcr.io/<project>/aegis:<tag> \
  --region <region> \
  --min-instances 2 \
  --max-instances 8 \
  --concurrency 40 \
  --cpu 1 \
  --memory 512Mi \
  --set-env-vars PROCESS_ROLE=http \
  --set-secrets "DATABASE_URL=aegis-db-url:latest,REDIS_URL=aegis-redis-url:latest,TELEGRAM_BOT_TOKEN=aegis-tg-token:latest,OPENAI_API_KEY=aegis-openai-key:latest,PRIVY_APP_SECRET=aegis-privy-secret:latest"
```

Sizing rationale at target (200 concurrent users):

- API qps peak ≈ 200 users × 1 req/5s = 40 qps (rough).
- `concurrency: 40` per replica × 2 min replicas = 80 concurrent inflight already headroom. Autoscales to 8 under burst for 320 total, enough for the `OPENAI_CONCURRENCY=6` bottleneck to be the actual cap, not the instance count.
- Memory 512 MiB is plenty at this code size (node baseline ~80 MiB + lru caches + app code ≈ 200 MiB observed).

### Upstash (Redis)

Provision an Upstash Redis database (Pay-as-you-go starter). Use the **TCP Redis** connection string, not the REST API — `ioredis` already does the right thing. Store as secret `aegis-redis-url`.

```
rediss://default:<password>@<host>.upstash.io:<port>
```

Verify from Cloud Run: Upstash is over public internet, so Cloud Run needs no VPC connector. Egress cost is ~1 KB/op × 40 qps = negligible.

### Postgres

Managed Postgres (e.g. Cloud SQL or Neon). Ensure `max_connections ≥ 250`. Budget: 8 api × 25 + 1 worker × 25 + migrations slack = 225.

## Step 4.3 — Local multi-replica parity

Add a compose profile to simulate the topology locally. Extend `docker-compose.yml`:

```yaml
services:
  # Existing `app`, `redis`, `postgres` stay as-is and remain the default
  # profile — single combined process for simple `npm run dev`-style work.

  # Multi-replica profile: run `docker compose --profile scale up` to start
  # 1 worker + 3 api behind an nginx load balancer, sharing Redis + Postgres.
  worker:
    profiles: ["scale"]
    build: .
    env_file: .env
    environment:
      PROCESS_ROLE: worker
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/jarvis
    depends_on: [redis, postgres]
    restart: unless-stopped

  api:
    profiles: ["scale"]
    build: .
    env_file: .env
    environment:
      PROCESS_ROLE: http
      HTTP_API_PORT: "8080"
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/jarvis
    depends_on: [redis, postgres]
    deploy:
      replicas: 3
    restart: unless-stopped

  lb:
    profiles: ["scale"]
    image: nginx:1.27-alpine
    ports:
      - "4000:80"
    volumes:
      - ./nginx.scale.conf:/etc/nginx/nginx.conf:ro
    depends_on: [api]
    restart: unless-stopped
```

New file `be/nginx.scale.conf`:

```nginx
events {}

http {
  upstream aegis_api {
    # Docker Compose DNS round-robins `api` to all 3 replicas.
    server api:8080;
  }

  server {
    listen 80;
    location / {
      proxy_pass http://aegis_api;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_read_timeout 60s;
    }
  }
}
```

### How to run locally

Default (unchanged for daily work):
```
docker compose up
```

Scaled topology (the Cloud Run simulation):
```
docker compose --profile scale up --build
```

You'll have:
- 1 × worker container (Telegram + jobs)
- 3 × api replicas
- nginx on `localhost:4000` round-robinning across them
- 1 × redis, 1 × postgres (shared)

### Verification checklist

1. Point the mini-app at `http://localhost:4000`. Login flow works (load-balanced across api replicas).
2. Run the multi-step test from Phase 2 Part 1's verification steps against `:4000` — the load balancer will scatter requests across replicas, and the flow must complete. This is the smoke test that proves Redis-backed pending store + no session cache is correct.
3. `docker compose logs api` should show all three replicas receiving traffic (`[httpCli] HTTP API-only replica up` × 3, and request logs interleaved).
4. `docker compose logs worker` shows job start banners exactly once.
5. Kill one api replica: `docker compose kill $(docker ps -qf "name=api" | head -1)`. Mini-app keeps working on the remaining two. No stuck multi-step flows.
6. Resurrect by `docker compose up -d api`; traffic rebalances.

## Step 4.4 — Load test

Install `k6` (or use `autocannon`). A minimal script at `be/scripts/load-chat.k6.js`:

```js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 50 },   // ramp
    { duration: "3m", target: 200 },  // sustain
    { duration: "1m", target: 0 },    // ramp-down
  ],
};

const TOKEN = __ENV.TEST_PRIVY_TOKEN;
const BASE = __ENV.BASE_URL || "http://localhost:4000";

export default function () {
  const res = http.get(`${BASE}/portfolio`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  check(res, { "status 200": (r) => r.status === 200 });
  sleep(5); // 5s between reqs per VU, mimics user behavior
}
```

Run against the scaled local compose:
```
TEST_PRIVY_TOKEN=<valid-test-token> k6 run scripts/load-chat.k6.js
```

Expectations at 200 VUs:
- P95 < 1.5 s on `/portfolio`
- Zero 5xx (some 429 from OpenAI is acceptable if the chat path is exercised — the concurrency cap will queue, raising P95)
- Redis ops/sec < 500 (Upstash free is 10k/day — plenty)
- Postgres `pg_stat_activity` active + idle < 200

If P95 blows up, check the Phase 3 parts (RPC fallback, caching, observability) for the hot spot.

## Step 4.5 — Cutover procedure

1. Build + push the new image: `gcloud builds submit --tag gcr.io/<project>/aegis:<tag>`.
2. Deploy **aegis-worker** first with the new image. Keep the existing combined service running.
3. Observe for 30 min: jobs firing correctly in worker logs, no duplicate Telegram messages (since combined still runs).
4. Delete the legacy combined service's `--min-instances=1` so it drains — or just bring it down. At this moment, Telegram polling transfers to aegis-worker (it holds the long-poll lease as soon as the legacy one disconnects).
5. Deploy **aegis-api** with `min=2 max=8`. Point the mini-app `VITE_API_BASE_URL` at the aegis-api URL.
6. Tear down the legacy combined service once no traffic hits it.

## Rollback

Redeploy the legacy combined service (previous Cloud Run revision). Point mini-app back at its URL. Aegis-api and aegis-worker can remain deployed but unreferenced; users won't hit them.

## Acceptance

- Local `--profile scale` compose brings up 1 worker + 3 api + nginx + redis + postgres and the mini-app works through `localhost:4000`.
- Multi-step Telegram flow survives one api replica being killed mid-flow.
- k6 200-VU test passes with P95 < 1.5 s on `/portfolio`.
- Two Cloud Run services deployed, combined service decommissioned.

## Record in STATUS.md

```
- 2026-04-24 — Production topology: `aegis-worker` (Cloud Run min=max=1,
  Telegram + jobs) + `aegis-api` (Cloud Run min=2 max=8, HTTP only). Shared
  Upstash Redis + managed Postgres. Single image, role chosen via PROCESS_ROLE.
  Local parity: `docker compose --profile scale up` (1 worker + 3 api + nginx).
  Do not raise aegis-worker beyond 1 replica without first solving
  job-singleton via Redis locks and grammy webhook-mode migration.
```
