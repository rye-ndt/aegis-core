#!/usr/bin/env bash
set -euo pipefail
URL="${1:-http://localhost:4000/metrics}"
TOKEN="${METRICS_TOKEN:-}"
while true; do
  curl -sS -H "authorization: Bearer ${TOKEN}" "$URL" | jq '{
    uptime: .process.uptimeSeconds,
    rssMb: .process.rssMb,
    pgPool: .pgPool,
    llm: {
      p50Ms: .llm.p50Ms,
      p95Ms: .llm.p95Ms,
      cacheHitRatio: (.llm.cacheHitRatio * 100 | floor),
      calls: .llm.callCount,
    },
    openaiLimiter: .openaiLimiter,
  }'
  sleep 5
done
