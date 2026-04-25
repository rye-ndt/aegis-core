# Onchain Agent (Aegis) — Backend

Non-custodial, intent-based AI trading agent on Avalanche. Users state natural-language intents in Telegram or the Mini App; the agent parses, resolves, and executes via ERC-4337 UserOps signed by the user's own ZeroDev session key. **The backend never holds a private key.**

## Quick start

```bash
npm install
cp .env.example .env             # fill DATABASE_URL, OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, PRIVY_*, etc.
npm run db:generate && npm run db:migrate
npm run dev                      # combined: HTTP API + Telegram bot + jobs
```

`PROCESS_ROLE` selects the entrypoint at runtime: `http` (API only), `worker` (bot + cron), `combined` (dev). Production builds a single esbuild bundle (`dist/server.js`) and dispatches via `src/entrypoint.ts`.

## Architecture (one paragraph)

Hexagonal Architecture (Ports & Adapters): use-cases depend only on interfaces under `src/use-cases/interface/`; concrete adapters live under `src/adapters/implementations/`; assembly happens exclusively in `src/adapters/inject/assistant.di.ts`. Every Telegram interaction routes through a `CapabilityDispatcher` to a typed `Capability` (`BuyCapability`, `SendCapability`, `SwapCapability`, `YieldCapability`, `LoyaltyCapability`, `AssistantChatCapability`); the Telegram handler is a thin auth gate + forwarder. Mini-app flows poll `GET /request/:id` for pending auth/sign/approve work and post results to `POST /response`. Multi-step flows (swap, yield) use `ISigningRequestUseCase.create` + `waitFor`.

## Features

- **Telegram + Mini App** — Privy auth (Google + Telegram auto-login), MTProto `@handle` resolution, `grammy` long-poll bot.
- **Intent pipeline** — OpenAI intent parser → schema compiler → resolver engine (per-field) → deterministic execution estimator → confirmation.
- **Capabilities** — `/buy` (onramp), `/send` family (`/money`, `/sell`, `/convert`, `/topup`, `/dca`), `/swap` (Relay-backed same-chain + cross-chain), `/yield` + `/withdraw` (Aave v3 on Avalanche mainnet), `/points` + `/leaderboard` (loyalty), free-text via assistant orchestrator.
- **Yield Optimizer** — proactive idle-USDC scanner; jobs for pool ranking (EMA-weighted score), per-user idle nudge, daily PnL reports. `GET /yield/positions` powers the mini-app's HomeTab.
- **Loyalty (Season 0)** — points ledger with idempotent awards, daily caps, anonymised leaderboard. Awards are fire-and-forget — host transactions never depend on success.
- **Aegis Guard** — per-token spending limits enforced before every spend (`token_delegations` table); shared `aegisGuardInterceptor` used by Send + Swap.
- **HTTP API** — native `node:http`, `exactRoutes` + `paramRoutes` dispatch. Includes `POST /health`, `GET /metrics` (bearer-gated).
- **Observability** — pino structured logging (one child logger per module), `MetricsRegistry` (pgPool, OpenAI p-limit, LLM latency, Redis), `[API xxxxxxxx]` request ids.
- **Scaling** — split entrypoints (`workerCli` 1 replica, `httpCli` N replicas), Privy-token LRU, Tavily/Relay Redis caches, RPC fallback list, OpenAI per-replica concurrency cap.

## Key rules (full list in `STATUS.md`)

1. Hexagonal architecture — no adapter↔adapter imports. Assembly only in `assistant.di.ts`.
2. Chain-specific values only in `src/helpers/chainConfig.ts`. Adding a chain = one `CHAIN_REGISTRY` entry.
3. No raw SQL outside Drizzle migrations.
4. Privy-token-only auth (no backend JWTs).
5. Time = seconds (`newCurrentUTCEpoch()`); IDs = `newUuid()` (v4).
6. New features = new `Capability` — never add flow logic to `handler.ts`.
7. **Backend never signs transactions.** All signing via user delegated session keys.

## Reference

- **`STATUS.md`** — source of truth for conventions, ports, env vars, Redis/DB schemas, feature log, and historical decisions. Read before changing code.
- **`thesis.md`** — high-level protocol thesis (LLM identity layer).
- **`CLAUDE.md` (repo root)** — code-style and logging rules for AI agents working in this repo.

## Deployment

Cloud Run (`us-east1`, project `aegis-494004`): `aegis-http` (0–3 replicas) + `aegis-worker` (pinned 1, no CPU throttling). Neon Postgres + Upstash Redis (free tier, same region). Secrets in Google Secret Manager. CI/CD via GitHub Actions + Workload Identity Federation (no JSON SA key). Single esbuild bundle, role chosen at deploy time. See `STATUS.md` → "Cloud Run deployment + GitHub Actions CI/CD".

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Combined dev (`tsx src/telegramCli.ts`) |
| `npm run db:generate` / `db:migrate` | Drizzle schema diff + apply |
| `npm test` | `npx tsx --test tests/*.test.ts` (capability + loyalty tests) |
| `npm run build` | esbuild single-bundle to `dist/server.js` |
| `scripts/watch-metrics.sh` | Tail `/metrics` during load tests |
