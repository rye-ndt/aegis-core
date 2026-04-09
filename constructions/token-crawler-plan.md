# Token Crawler — Implementation Plan

> Authored: 2026-04-09  
> Status: Awaiting implementation  
> Feature: Periodic token list ingestion → `token_registry` DB upsert

---

## 0. What This Builds

A background job that fetches the Pangolin token list every 15 minutes and upserts every token into the `token_registry` table. The job is hexagonally clean: a port interface defines the contract, one concrete adapter implements Pangolin, and a scheduler owns the timer. Future crawlers (CoinGecko, Trader Joe, custom APIs) add only a new adapter file — no other code changes.

---

## 1. Schema Migration

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

Add one nullable column to the existing `tokenRegistry` table:

```typescript
deployerAddress: text("deployer_address"),
```

The full updated table definition (only show the diff — add the new column after `logoUri`):

```typescript
export const tokenRegistry = pgTable("token_registry", {
  id: uuid("id").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  chainId: integer("chain_id").notNull(),
  address: text("address").notNull(),
  decimals: integer("decimals").notNull(),
  isNative: boolean("is_native").notNull().default(false),
  isVerified: boolean("is_verified").notNull().default(false),
  logoUri: text("logo_uri"),
  deployerAddress: text("deployer_address"),       // ← ADD THIS
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
}, (t) => ({
  symbolChainUniq: unique().on(t.symbol, t.chainId),
}));
```

After editing the schema file, run:

```bash
npm run db:generate
npm run db:migrate
```

**Guardrail:** Do not rename or remove any existing columns. Only add `deployer_address`.

---

## 2. Extend Domain Types

**File:** `src/use-cases/interface/output/repository/tokenRegistry.repo.ts`

Add `deployerAddress` to both existing interfaces:

```typescript
export interface ITokenRecord {
  id: string;
  symbol: string;
  name: string;
  chainId: number;
  address: string;
  decimals: number;
  isNative: boolean;
  isVerified: boolean;
  logoUri?: string | null;
  deployerAddress?: string | null;   // ← ADD
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface TokenRecordInit {
  id: string;
  symbol: string;
  name: string;
  chainId: number;
  address: string;
  decimals: number;
  isNative?: boolean;
  isVerified?: boolean;
  logoUri?: string | null;
  deployerAddress?: string | null;   // ← ADD
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

// ITokenRegistryDB is unchanged — upsert/findBySymbolAndChain/listByChain stay as-is
```

---

## 3. Update Drizzle Repo to Persist the New Column

**File:** `src/adapters/implementations/output/sqlDB/repositories/tokenRegistry.repo.ts`

In the `upsert` method, add `deployerAddress` to both the `.values({...})` block and the `.onConflictDoUpdate({ set: {...} })` block:

```typescript
// inside .values({...})
deployerAddress: token.deployerAddress ?? null,

// inside .onConflictDoUpdate({ set: {...} })
deployerAddress: token.deployerAddress ?? null,
```

In the `toRecord` private method, map the new column:

```typescript
deployerAddress: row.deployerAddress,
```

**Guardrail:** The `upsert` conflict target is `[tokenRegistry.symbol, tokenRegistry.chainId]` — do not change it.

---

## 4. Define the Port Interface

**New file:** `src/use-cases/interface/output/tokenCrawler.interface.ts`

```typescript
export interface CrawledToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  isNative: boolean;
  logoUri?: string | null;
  deployerAddress?: string | null;
}

export interface ITokenCrawlerJob {
  /**
   * Fetch all tokens for the given chainId from the external source.
   * Returns an empty array (never throws) if the source is unreachable.
   */
  fetchTokens(chainId: number): Promise<CrawledToken[]>;
}
```

**Guardrail:** This file contains only types and an interface — zero imports from adapters, zero `fetch` calls, zero business logic.

---

## 5. Concrete Adapter — Pangolin Token Crawler

**New file:** `src/adapters/implementations/output/tokenCrawler/pangolin.tokenCrawler.ts`

Source URL (hard-coded constant, not env var): `https://raw.githubusercontent.com/pangolindex/tokenlists/main/pangolin.tokenlist.json`

The Pangolin list follows the Uniswap token list standard. Its shape is:

```json
{
  "tokens": [
    {
      "chainId": 43114,
      "address": "0x...",
      "symbol": "PNG",
      "name": "Pangolin",
      "decimals": 18,
      "logoURI": "https://..."
    }
  ]
}
```

Implementation rules:
- Use the native Node.js `fetch` (available in Node 18+). No extra HTTP lib.
- Parse with `JSON.parse`. Do **not** use Zod here — the list is large; a single bad token should be skipped, not crash the job.
- Filter: keep only rows where `token.chainId === chainId`.
- Map each valid row to `CrawledToken`. Fields:
  - `symbol` → `token.symbol` — **uppercase it** (`token.symbol.toUpperCase()`)
  - `name` → `token.name`
  - `address` → `token.address` (keep as-is; the list already provides checksummed addresses)
  - `decimals` → `token.decimals`
  - `chainId` → `token.chainId`
  - `isNative` → `false` (Pangolin list has no native AVAX entry; AVAX is seeded separately)
  - `logoUri` → `token.logoURI ?? null`
  - `deployerAddress` → `null` (Pangolin list does not expose deployer)
- Skip any row missing `address`, `symbol`, `name`, or `decimals` (guard against malformed entries).
- On network error or non-200 response: log the error with `console.error`, return `[]`.

```typescript
import type { CrawledToken, ITokenCrawlerJob } from "../../../../use-cases/interface/output/tokenCrawler.interface";

const PANGOLIN_LIST_URL = "https://raw.githubusercontent.com/pangolindex/tokenlists/main/pangolin.tokenlist.json";

export class PangolinTokenCrawler implements ITokenCrawlerJob {
  async fetchTokens(chainId: number): Promise<CrawledToken[]> {
    try {
      const res = await fetch(PANGOLIN_LIST_URL);
      if (!res.ok) {
        console.error(`[PangolinTokenCrawler] HTTP ${res.status}`);
        return [];
      }
      const json = await res.json() as { tokens?: unknown[] };
      if (!Array.isArray(json.tokens)) return [];

      const result: CrawledToken[] = [];
      for (const t of json.tokens) {
        const token = t as Record<string, unknown>;
        if (
          typeof token.address !== "string" ||
          typeof token.symbol !== "string" ||
          typeof token.name !== "string" ||
          typeof token.decimals !== "number" ||
          typeof token.chainId !== "number"
        ) continue;
        if (token.chainId !== chainId) continue;
        result.push({
          symbol: token.symbol.toUpperCase(),
          name: token.name,
          address: token.address,
          decimals: token.decimals,
          chainId: token.chainId,
          isNative: false,
          logoUri: typeof token.logoURI === "string" ? token.logoURI : null,
          deployerAddress: null,
        });
      }
      return result;
    } catch (err) {
      console.error("[PangolinTokenCrawler] fetch failed:", err);
      return [];
    }
  }
}
```

---

## 6. Scheduler

**New file:** `src/adapters/implementations/output/tokenCrawler/tokenCrawlerScheduler.ts`

The scheduler owns the `setInterval` timer. It depends only on the port interface `ITokenCrawlerJob` and `ITokenRegistryDB`.

```typescript
import type { ITokenCrawlerJob } from "../../../../use-cases/interface/output/tokenCrawler.interface";
import type { ITokenRegistryDB, TokenRecordInit } from "../../../../use-cases/interface/output/repository/tokenRegistry.repo";
import { newUuid } from "../../../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export class TokenCrawlerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly crawler: ITokenCrawlerJob,
    private readonly tokenRegistryDB: ITokenRegistryDB,
    private readonly chainId: number,
  ) {}

  start(): void {
    this.run();                              // run immediately on boot
    this.timer = setInterval(() => this.run(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    console.log("[TokenCrawlerScheduler] fetching token list...");
    const tokens = await this.crawler.fetchTokens(this.chainId);
    if (tokens.length === 0) {
      console.log("[TokenCrawlerScheduler] no tokens returned, skipping upsert");
      return;
    }
    const now = newCurrentUTCEpoch();
    let upserted = 0;
    for (const token of tokens) {
      const record: TokenRecordInit = {
        id: newUuid(),
        symbol: token.symbol,
        name: token.name,
        chainId: token.chainId,
        address: token.address,
        decimals: token.decimals,
        isNative: token.isNative,
        isVerified: false,                  // crawler tokens are unverified by default
        logoUri: token.logoUri ?? null,
        deployerAddress: token.deployerAddress ?? null,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      };
      try {
        await this.tokenRegistryDB.upsert(record);
        upserted++;
      } catch (err) {
        console.error(`[TokenCrawlerScheduler] upsert failed for ${token.symbol}:`, err);
      }
    }
    console.log(`[TokenCrawlerScheduler] upserted ${upserted}/${tokens.length} tokens for chainId=${this.chainId}`);
  }
}
```

**Guardrail:** `isVerified` is always `false` for crawler-ingested tokens. Verified tokens are set manually or via a future trust-scoring step. Do not set it to `true` here.

**Guardrail:** The `id` in `TokenRecordInit` is a new UUID on every call — that is intentional. The Drizzle `upsert` uses `onConflictDoUpdate` on `(symbol, chainId)`, so the `id` is only used on first insert.

---

## 7. DI Wiring

**File:** `src/adapters/inject/assistant.di.ts`

### 7.1 Imports to add

```typescript
import { PangolinTokenCrawler } from "../implementations/output/tokenCrawler/pangolin.tokenCrawler";
import { TokenCrawlerScheduler } from "../implementations/output/tokenCrawler/tokenCrawlerScheduler";
```

### 7.2 Private field to add inside `AssistantInject`

```typescript
private _tokenCrawlerScheduler: TokenCrawlerScheduler | null = null;
```

### 7.3 New method to add inside `AssistantInject`

```typescript
getTokenCrawlerScheduler(): TokenCrawlerScheduler {
  if (!this._tokenCrawlerScheduler) {
    const chainId = parseInt(process.env.CHAIN_ID ?? "43113", 10);
    this._tokenCrawlerScheduler = new TokenCrawlerScheduler(
      new PangolinTokenCrawler(),
      this.getSqlDB().tokenRegistry,
      chainId,
    );
  }
  return this._tokenCrawlerScheduler;
}
```

Place this method after `getTokenRegistryService()`.

---

## 8. Entry Point Wiring

**File:** `src/telegramCli.ts`

### 8.1 Start the scheduler after the HTTP server starts

Add after `httpServer.start()`:

```typescript
const tokenCrawlerScheduler = inject.getTokenCrawlerScheduler();
tokenCrawlerScheduler.start();
```

### 8.2 Stop the scheduler on SIGINT

Inside the `process.on("SIGINT", ...)` handler, add before `process.exit(0)`:

```typescript
tokenCrawlerScheduler.stop();
```

The final SIGINT handler should be:

```typescript
process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  tokenCrawlerScheduler.stop();
  httpServer.stop();
  await bot.stop();
  process.exit(0);
});
```

---

## 9. File Checklist (all files touched or created)

| Action | File |
|--------|------|
| MODIFY | `src/adapters/implementations/output/sqlDB/schema.ts` |
| MODIFY | `src/use-cases/interface/output/repository/tokenRegistry.repo.ts` |
| MODIFY | `src/adapters/implementations/output/sqlDB/repositories/tokenRegistry.repo.ts` |
| CREATE | `src/use-cases/interface/output/tokenCrawler.interface.ts` |
| CREATE | `src/adapters/implementations/output/tokenCrawler/pangolin.tokenCrawler.ts` |
| CREATE | `src/adapters/implementations/output/tokenCrawler/tokenCrawlerScheduler.ts` |
| MODIFY | `src/adapters/inject/assistant.di.ts` |
| MODIFY | `src/telegramCli.ts` |
| RUN    | `npm run db:generate && npm run db:migrate` |

---

## 10. Implementation Order

Follow this order strictly — each step compiles before the next begins:

1. **Schema** — edit `schema.ts`, run `db:generate && db:migrate`.
2. **Domain types** — edit `tokenRegistry.repo.ts` (interface file).
3. **Drizzle repo** — edit the concrete Drizzle repo to persist `deployerAddress`.
4. **Port interface** — create `tokenCrawler.interface.ts`.
5. **Pangolin adapter** — create `pangolin.tokenCrawler.ts`.
6. **Scheduler** — create `tokenCrawlerScheduler.ts`.
7. **DI** — edit `assistant.di.ts`.
8. **Entry point** — edit `telegramCli.ts`.

**Guardrail:** After step 3, verify TypeScript still compiles (`npx tsc --noEmit`) before proceeding. The rest of the chain only adds code, not changes to existing contracts.

---

## 11. Adding Future Crawlers

To add a second token list source (e.g., Trader Joe, CoinGecko):

1. Create `src/adapters/implementations/output/tokenCrawler/traderJoe.tokenCrawler.ts` implementing `ITokenCrawlerJob`.
2. In `assistant.di.ts`, swap `new PangolinTokenCrawler()` for the new impl, or compose multiple crawlers behind a `MultiSourceTokenCrawler` that merges results.
3. No other files need to change.
