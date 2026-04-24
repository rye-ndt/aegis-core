# Scaling Phase 2 — Part 3: Worker process split

> Prerequisites: Phase 2 parts 1 + 2 merged.
> Blocks: part 4 (multi-replica deploy). Without this, background jobs fire on every replica.
> Behavior change: **none** when run with the same topology (one worker, one API). Observable side effect: jobs stop sharing CPU with chat traffic — requests during crawler runs get faster.

## Why

`src/telegramCli.ts:33-47` starts four scheduled jobs on the same process that handles Telegram bot + HTTP API:

```ts
const tokenCrawlerJob = inject.getTokenCrawlerJob();
tokenCrawlerJob.start();

const yieldPoolScanJob = inject.getYieldPoolScanJob();
yieldPoolScanJob?.start();

const userIdleScanJob = inject.getUserIdleScanJob();
userIdleScanJob?.start();

const yieldReportJob = inject.getYieldReportJob();
yieldReportJob?.start();
```

Consequences under multi-replica:

1. **Duplicate work.** Each replica starts its own crawler/scanner/notifier. `userIdleScanJob` would send the same idle notification to each user N times (once per replica).
2. **CPU contention.** The 15-min crawler and 5-min yield tick run on the API replicas, adding latency spikes to chat traffic during sweeps.

Additionally, **the Telegram bot can only be operated from one process**: grammy's long-poll holds an exclusive lease, and a webhook variant still routes to one endpoint. So today's architecture is already "single Telegram consumer" — the scale-out path is:

- **1 worker replica**: Telegram long-poll + all background jobs (CPU-intensive, low-throughput).
- **N API replicas**: HTTP API only, stateless, autoscaled. Handles mini-app traffic (`/portfolio`, `/request/:id`, `/auth/privy`, `/chat` if exposed).

## Step 3.1 — Create the API-only entrypoint

New file `src/httpCli.ts`:

```ts
import "dotenv/config";
import { AssistantInject } from "./adapters/inject/assistant.di";

(async () => {
  const inject = new AssistantInject();

  // HTTP-only replica: no Telegram bot, no background jobs.
  // The signing-request use-case needs a notify callback for when a user
  // resolves a pending signature; in the API-replica role we still send
  // that notification, since the bot's api-client is shared via token.
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!tgToken) {
    console.error("TELEGRAM_BOT_TOKEN is required (for outbound notifications).");
    process.exit(1);
  }
  const { Api } = await import("grammy");
  const tgApi = new Api(tgToken);
  const notifyResolved = async (chatId: number, txHash: string | undefined, rejected: boolean): Promise<void> => {
    if (rejected) {
      await tgApi.sendMessage(chatId, "Transaction rejected in the app.");
    } else {
      await tgApi.sendMessage(chatId, `Transaction submitted.\nTx hash: \`${txHash ?? "unknown"}\``, { parse_mode: "Markdown" });
    }
  };

  const signingRequestUseCase = inject.getSigningRequestUseCase(notifyResolved);
  const httpServer = inject.getHttpApiServer(signingRequestUseCase);
  httpServer.start();

  console.log("[httpCli] HTTP API-only replica up.");

  process.on("SIGTERM", async () => {
    console.log("[httpCli] SIGTERM — shutting down…");
    httpServer.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.log("[httpCli] SIGINT — shutting down…");
    httpServer.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });
})();
```

Notes:
- This intentionally does **not** call `inject.setBot(...)`. The bot object is only used by the Telegram long-poll loop and by the `TelegramArtifactRenderer` (which attaches to the bot object to send async user notifications). We still need outbound sends — those go through `tgApi.sendMessage` directly, or via a lightweight `TelegramNotifier` that doesn't require the long-poll-owning `Bot` instance.
- Audit: `grep -n "this.getBot()" src/adapters/inject/assistant.di.ts` — find every call and confirm each DI getter that needs `getBot()` is either (a) never reached in the HTTP-only path, or (b) gracefully returns undefined. Current candidates to verify: `getTelegramNotifier` (line 430), `getCapabilityDispatcher` (line 601), `getYieldReportJob` (line 776). For the HTTP path, `getCapabilityDispatcher` is also needed — see Step 3.3.

## Step 3.2 — Rename the combined entrypoint to make roles explicit

Rename `src/telegramCli.ts` → keep the file (don't break deployments mid-migration). Add a sibling `src/workerCli.ts` that is the telegram+jobs role.

Easiest approach: **keep `telegramCli.ts` as-is** and create `src/workerCli.ts` that does exactly what `telegramCli.ts` does now. Document:

- `src/telegramCli.ts` → legacy combined entrypoint. Still usable for single-process local dev.
- `src/workerCli.ts` → Telegram bot + scheduled jobs. Deploy as exactly 1 replica.
- `src/httpCli.ts` → HTTP API only. Deploy as N replicas, autoscaled.

New file `src/workerCli.ts` — copy of current `src/telegramCli.ts` byte-for-byte, rename the final console log to `"[workerCli] worker role up"`.

`src/telegramCli.ts` stays the combined dev entrypoint. `npm run dev` keeps working for local hacking.

## Step 3.3 — `package.json` scripts

Edit `be/package.json` scripts:

```json
"dev": "tsx watch src/telegramCli.ts",
"dev:worker": "tsx watch src/workerCli.ts",
"dev:http": "tsx watch src/httpCli.ts",
"start:worker": "node dist/workerCli.js",
"start:http": "node dist/httpCli.js"
```

Keep `"main": "dist/telegramCli.js"` unchanged (it's only a metadata hint; no tooling in this repo depends on `main`).

## Step 3.4 — Build the new entrypoints

`tsc` compiles every `.ts` under `src/` already (no `files:` restriction in `tsconfig.json` — verify). Running `npm run build` after adding the two files should emit `dist/workerCli.js` and `dist/httpCli.js` automatically. If `tsconfig.json` has an `"include"` restricted list, add `"src/workerCli.ts"` and `"src/httpCli.ts"`.

## Step 3.5 — Guard against accidental dual-start of jobs

Add a belt-and-suspenders check in each job's `start()` or in a helper. Simplest: an env flag that `workerCli.ts` sets and `httpCli.ts` doesn't. New file `src/helpers/env/role.ts`:

```ts
export type ProcessRole = "worker" | "http" | "combined";

export function getProcessRole(): ProcessRole {
  const raw = (process.env.PROCESS_ROLE ?? "combined").toLowerCase();
  if (raw === "worker" || raw === "http") return raw;
  return "combined";
}

export function isWorker(): boolean {
  const role = getProcessRole();
  return role === "worker" || role === "combined";
}
```

In `src/workerCli.ts` set `process.env.PROCESS_ROLE = "worker"` before `new AssistantInject()`.
In `src/httpCli.ts` set `process.env.PROCESS_ROLE = "http"`.

Then in `src/telegramCli.ts` (the combined dev entry) leave unset — it defaults to `"combined"` and runs everything.

In each job file (`src/adapters/implementations/input/jobs/tokenCrawlerJob.ts`, `yieldPoolScanJob.ts`, `userIdleScanJob.ts`, `yieldReportJob.ts`) at the top of `start()`:

```ts
import { isWorker } from "../../../../helpers/env/role";

start() {
  if (!isWorker()) {
    console.log(`[${this.constructor.name}] not a worker role — not starting.`);
    return;
  }
  // ... existing logic
}
```

This is defense in depth — if someone accidentally copies `workerCli`'s job-start block into `httpCli`, the jobs refuse to run.

## Step 3.6 — `.env.example`

Append:

```
# Set by workerCli.ts / httpCli.ts automatically. Only override for tests.
PROCESS_ROLE=combined
```

## How to verify locally

1. `docker compose up -d postgres redis`.
2. **Split-process test:**
   - Terminal A: `npm run dev:worker`
   - Terminal B: `PORT=4001 npm run dev:http`
3. In Terminal A logs: `[workerCli] worker role up`. Jobs print their start banners (e.g. `[TokenCrawlerJob] scheduled every 15 min`).
4. In Terminal B logs: `[httpCli] HTTP API-only replica up`. No job banners. Any job `start()` calls should print `not a worker role`.
5. Drive a mini-app flow against `localhost:4001` (http replica) while terminal A's Telegram bot handles `/start`, `/chat`, etc.
6. `docker compose down redis` and watch terminal A — `getRedis()` returns undefined, pending-collection falls back to in-memory (single-worker still correct).
7. `npx tsc --noEmit` — clean. `npm run build` — dist has `workerCli.js` and `httpCli.js`.

## Rollback

Remove the two new entrypoints and the `isWorker()` guards. `telegramCli.ts` is unchanged, so single-process deploys keep running.

## Acceptance

- Compile clean.
- `dist/workerCli.js` and `dist/httpCli.js` exist after build.
- Jobs do **not** start when `PROCESS_ROLE=http`; they do start when unset or `worker`.
- HTTP endpoints respond correctly from the http-role process.
- Legacy `telegramCli.ts` still works as before (combined dev role).

## Record in STATUS.md

```
- 2026-04-24 — Split entrypoints: `src/workerCli.ts` (Telegram bot + scheduled
  jobs; exactly 1 replica) and `src/httpCli.ts` (HTTP API only; N replicas).
  `src/telegramCli.ts` retained as combined local-dev entry. `PROCESS_ROLE`
  env (`worker` | `http` | `combined`) gates job startup via `helpers/env/role.ts`.
  Deploying > 1 worker replica will duplicate Telegram notifications — enforce
  max-instances=1 on the worker Cloud Run service.
```
