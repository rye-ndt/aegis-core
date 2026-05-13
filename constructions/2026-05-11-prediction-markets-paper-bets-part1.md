# Prediction Markets — Paper Bets — Part 1 (Schema + Port + Repo)

Date: 2026-05-11
Status: plan
Index: `2026-05-11-prediction-markets-paper-bets.md`
Prerequisite: none.
Unblocks: Part 2 (placement use-case), Part 3 (resolution job).

## Goal

Land the persistence layer for paper bets — one new table, one port, one drizzle-backed repository — without touching any runtime path yet. After this part, the codebase compiles and tests pass, but no caller writes to the new table.

## Files added

- `be/src/use-cases/interface/predictionMarket/IPredictionMarketPaperBetRepository.ts` — port.
- `be/src/use-cases/interface/predictionMarket/PaperBetTypes.ts` — domain types (`PaperBet`, `PaperBetSide`, `PaperBetStatus`).
- `be/src/adapters/implementations/output/sqlDB/repositories/predictionMarketPaperBet.repo.ts` — drizzle impl.
- `be/drizzle/<next-idx>_<auto-name>.sql` — drizzle-generated migration.

## Files changed

- `be/src/adapters/implementations/output/sqlDB/schema.ts` — append `predictionMarketPaperBets` table definition next to the existing PM schema block (~line 519+).
- `be/drizzle/meta/_journal.json` — drizzle-generate updates this; **manually verify** the new `when` value is strictly greater than the prior maximum per CLAUDE.md migration rule.

## Table — `prediction_market_paper_bets`

```ts
export const predictionMarketPaperBets = pgTable(
  "prediction_market_paper_bets",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // who & what
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id").notNull().references(() => predictionMarketFindings.id),
    clusterId: uuid("cluster_id").notNull(),         // denorm, no FK (clusters table churns)
    marketId: text("market_id").notNull(),            // polymarket market id (CLOB-side)
    subject: text("subject"),                         // denorm of cluster.derivedSubject; null for LLM-clustered findings

    // bet shape
    side: text("side", { enum: ["YES", "NO"] }).notNull(),
    stakeUsdcCents: integer("stake_usdc_cents").notNull(),
    entryPriceBps: integer("entry_price_bps").notNull(),     // CLOB top-of-book at confirm
    sharesE6: bigint("shares_e6", { mode: "bigint" }).notNull(),  // shares * 1e6, derived from stake/price

    // detector provenance — for sliced ROI in Part 3
    detectorSource: text("detector_source", { enum: ["deterministic", "llm"] }).notNull(),

    // resolution
    status: text("status", { enum: ["open", "resolved", "voided"] }).notNull().default("open"),
    outcome: text("outcome", { enum: ["YES", "NO"] }),
    payoutUsdcCents: integer("payout_usdc_cents"),
    realizedPnlUsdcCents: integer("realized_pnl_usdc_cents"),

    // timestamps
    entryAt: timestamp("entry_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    byUserStatus: index("paper_bets_user_status_idx").on(t.userId, t.status),
    byFinding: index("paper_bets_finding_idx").on(t.findingId),
    byMarketStatus: index("paper_bets_market_status_idx").on(t.marketId, t.status),
    bySubject: index("paper_bets_subject_idx").on(t.subject),
  })
);
```

### Column notes

- **`sharesE6`** — fixed-point integer (shares × 1e6) so we never persist floats and can sum/aggregate exactly. Derivation: `sharesE6 = (stakeUsdcCents * 10000 * 1_000_000) / (entryPriceBps * 100)` → `sharesE6 = (stakeUsdcCents * 1_000_000) / (entryPriceBps / 100)`. Done in JS as BigInt before insert. Documented in `PaperBetTypes.ts` for posterity.
- **`payoutUsdcCents`** — gross payout on win = `sharesE6 / 1_000_000 × 10_000` cents (Polymarket pays $1 per winning share = 10 000 cents). On loss = 0. `null` while `status='open'`.
- **`realizedPnlUsdcCents`** = `payoutUsdcCents - stakeUsdcCents`. Range allows negatives. `null` while `status='open'`.
- **`detectorSource`** — set at insert time by reading the cluster's `derivedSubject` (non-null → `deterministic`, null → `llm`). This is the **evaluation hinge**: we need to slice ROI by which detector produced the finding.
- **`subject`** denormalized from the cluster row to avoid join cost on aggregation queries that will run frequently in Part 3.
- **`clusterId`** denormalized for the same reason; no FK because cluster rows are versioned per scan (`is_latest` flag) and we want paper bets to outlive cluster churn.
- **`status='voided'`** reserved for the case where the underlying market is invalidated by Polymarket (resolution disputed / cancelled). Out of scope this round but the enum value is in place so we don't need a future migration.

## Domain types

`be/src/use-cases/interface/predictionMarket/PaperBetTypes.ts`:

```ts
export type PaperBetSide = "YES" | "NO";
export type PaperBetStatus = "open" | "resolved" | "voided";
export type DetectorSource = "deterministic" | "llm";

export interface PaperBet {
  id: string;
  userId: string;
  findingId: string;
  clusterId: string;
  marketId: string;
  subject: string | null;
  side: PaperBetSide;
  stakeUsdcCents: number;
  entryPriceBps: number;
  sharesE6: bigint;
  detectorSource: DetectorSource;
  status: PaperBetStatus;
  outcome: PaperBetSide | null;
  payoutUsdcCents: number | null;
  realizedPnlUsdcCents: number | null;
  entryAt: Date;
  resolvedAt: Date | null;
}

export interface PaperBetInsert {
  userId: string;
  findingId: string;
  clusterId: string;
  marketId: string;
  subject: string | null;
  side: PaperBetSide;
  stakeUsdcCents: number;
  entryPriceBps: number;
  sharesE6: bigint;
  detectorSource: DetectorSource;
}

export interface PaperBetResolutionPatch {
  id: string;
  outcome: PaperBetSide;
  payoutUsdcCents: number;
  realizedPnlUsdcCents: number;
}
```

Pure types only. No methods. The "shares" derivation helper lives in the use-case (Part 2), not here — types stay framework-free.

## Port

`be/src/use-cases/interface/predictionMarket/IPredictionMarketPaperBetRepository.ts`:

```ts
export interface IPredictionMarketPaperBetRepository {
  insert(row: PaperBetInsert): Promise<PaperBet>;
  findById(id: string): Promise<PaperBet | null>;

  /** Bets a user has placed, newest first. */
  listByUser(userId: string, opts?: { limit?: number; status?: PaperBetStatus }): Promise<PaperBet[]>;

  /** Open bets across all users for a set of marketIds (used by the resolution job). */
  listOpenByMarkets(marketIds: string[]): Promise<PaperBet[]>;

  /** Distinct marketIds across all open bets (resolution job seed). */
  listOpenMarketIds(): Promise<string[]>;

  /** Atomic batch update — used by resolution job to settle many bets per market in one round-trip. */
  resolveMany(patches: PaperBetResolutionPatch[]): Promise<number>;

  /** Aggregate stats. Sliced by the requested `groupBy` field. */
  aggregatePerformance(args: {
    userId?: string; // omit for global
    groupBy: "overall" | "subject" | "clusterId" | "detectorSource";
    status?: PaperBetStatus; // default 'resolved' (only resolved bets count toward realized ROI)
  }): Promise<PerformanceBucket[]>;
}

export interface PerformanceBucket {
  key: string;                        // "overall" | subject code | clusterId | detector source
  betCount: number;
  totalStakeUsdcCents: number;
  totalPayoutUsdcCents: number;
  totalPnlUsdcCents: number;
  wins: number;
  losses: number;
  winRateBps: number;                 // wins / (wins+losses) × 10_000
  roiBps: number;                     // pnl / stake × 10_000
}
```

## Repository implementation

`be/src/adapters/implementations/output/sqlDB/repositories/predictionMarketPaperBet.repo.ts`:

- Mirror the conventions of `predictionMarketBet.repo.ts` (same file is the closest sibling).
- `const log = createLogger('PaperBetRepo')`.
- `insert` — single `INSERT ... RETURNING *`. Log `info({ findingId, userId, side, stakeUsdcCents }, "paper-bet inserted")`.
- `resolveMany` — wrap in a transaction; one `UPDATE` per patch (Postgres has no good batched-update primitive without `VALUES (...)` join, which is overkill for tens of rows per tick). Log `info({ count }, "paper-bets resolved")`.
- `aggregatePerformance` — single SQL query using drizzle's aggregation builder. Buckets:
  - `overall` → no `GROUP BY`.
  - `subject` → `GROUP BY subject`. `NULL` subject becomes bucket `"_unsubjected"`.
  - `clusterId` → `GROUP BY cluster_id`.
  - `detectorSource` → `GROUP BY detector_source`.
  - Always filter to `status = 'resolved'` unless the caller overrides. Reasoning: realized ROI is the metric; open bets have no meaningful contribution until resolved.
  - All fields computed in SQL — `SUM(stake_usdc_cents)`, `SUM(payout_usdc_cents)`, `SUM(realized_pnl_usdc_cents)`, `COUNT(*) FILTER (WHERE realized_pnl_usdc_cents > 0)` for wins, `COUNT(*) FILTER (WHERE realized_pnl_usdc_cents <= 0)` for losses. `winRateBps` and `roiBps` computed in JS post-query (cheap, avoids DIV-by-zero edge cases in SQL).
- No per-row debug logs on the aggregation path — the operation-boundary log (`info({ groupBy, userId }, "aggregate performance")`) is enough per CLAUDE.md logging rules.

## Migration

```bash
cd be
npm run db:generate -- --name predictionMarketPaperBets
```

**Verification step (CLAUDE.md migration rule)** — open `be/drizzle/meta/_journal.json` and confirm the new entry's `when` field is strictly greater than the prior maximum. If drizzle-kit stamped it lower than the journaled `1778889600000+` values, bump it to one tick above the previous max (e.g. `1778889600005`) before running `db:migrate`. After migrate, query `information_schema.columns` to confirm `prediction_market_paper_bets.id` exists. Do not edit the generated SQL file.

## Tests

`be/src/__tests__/predictionMarketPaperBetRepo.test.ts` (new):

- `insert + findById` round-trip preserves bigint `sharesE6`.
- `resolveMany` is atomic — interrupt mid-batch and confirm no partial commit.
- `aggregatePerformance({ groupBy: 'detectorSource' })` returns correct `winRateBps` and `roiBps` for a hand-crafted fixture of 4 bets (1 win deterministic, 1 loss deterministic, 1 win llm, 1 loss llm).
- `aggregatePerformance` excludes `open` bets by default.

Use the existing pg test harness (search `be/src/__tests__/` for a sibling repo test for the boilerplate).

## DI wiring

**Deferred to Part 2.** The repo is registered in `assistant.di.ts` alongside the use-case so the wiring change is one commit, not two.

## Logging fields introduced

New metadata field names introduced by this part (record in `be/STATUS.md` per CLAUDE.md):

- `betCount` (aggregate result size)
- `groupBy` (aggregation axis)
- `detectorSource` (`deterministic` | `llm`)

## Acceptance

- `npm run typecheck` passes.
- `npm run db:migrate` lands the new table; `\d prediction_market_paper_bets` shows the four indexes.
- Repo unit tests pass.
- No production code path writes to the table yet.
