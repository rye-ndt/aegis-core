# Prediction Markets — Paper Bets (Evaluation Mode)

Date: 2026-05-11
Status: plan
Parts:
- Part 1 — schema + repo + port (`2026-05-11-prediction-markets-paper-bets-part1.md`)
- Part 2 — placement use-case + HTTP routes + DI wiring (`2026-05-11-prediction-markets-paper-bets-part2.md`)
- Part 3 — resolution polling job + performance endpoints (`2026-05-11-prediction-markets-paper-bets-part3.md`)
- Part 4 — frontend `PaperBetHandler` + deep-link reroute + status docs (`fe/privy-auth/constructions/2026-05-11-prediction-markets-paper-bets-part4.md`)

## Goal

Replace the on-chain bet flow with a **paper-bet** (simulated) flow so we can measure whether the prediction-market model is profitable **before** any real money moves. Every broadcast finding still surfaces a "Place Bet" button; clicking it asks the user for a stake amount, snapshots the live CLOB top-of-book price, and persists the bet to a new DB table. A background job polls Polymarket for resolution and writes realized P&L. Aggregation endpoints expose per-subject / per-cluster / per-detector-source ROI.

## Foundational decisions (user-confirmed 2026-05-11)

1. **Replace, don't toggle.** The on-chain pipeline is dormant — we do not gate on an env flag. The existing real-bet adapters/use-cases stay in the codebase (blast radius of removal is large) but the broadcast deep-link no longer reaches them. Re-enabling the real flow later means re-pointing the FE route, nothing more.
2. **Prompt for amount.** Mini-app asks the user for a USDC stake on each click (no fixed notional). This mirrors the real flow's UX and gives us a per-user stake-sizing signal alongside the model signal.
3. **Live CLOB top-of-book at confirmation.** Entry price is fetched fresh via `polymarketAdapter.getOrderBookTop(marketId)` at the moment of confirmation, not from `prediction_market_snapshots`. This is what a real bet would have paid.
4. **Resolution job in scope.** We poll Polymarket for outcome and compute realized P&L now — without this the table is unevaluable. Mark-to-market dashboards can come later.
5. **Skip the SCA setup gate.** No wallet, no approvals, no bridge. The flow is pure HTTP: amount → confirm → DB write.

## Cross-cutting invariants

- **Broadcast contract unchanged.** Telegram callback payload remains `place_bet:findingId:A|B`. FE deep-link query stays the same. Only the page mounted at the destination changes. (Status-doc note: see `fe/privy-auth/status.md` "Prediction markets" section.)
- **Hexagonal boundary holds.** New work introduces one port (`IPredictionMarketPaperBetRepository`), one use-case (`PredictionMarketPaperBetUseCase`), and one adapter implementation. The Polymarket fetch reuses the existing `IPolymarketAdapter` for prices and a small extension for resolution lookup — no chain-specific code leaks elsewhere.
- **Logging mandate** (CLAUDE.md): every new module gets `const log = createLogger('…')`, every multi-stage flow emits `step` events (`started` / `submitted` / `succeeded` / `failed`) with `reqId`/`userId`, every catch logs `{ err }` before rethrowing. Privacy rules apply — never log raw Privy tokens or session payloads.
- **No raw SQL migrations** — drizzle only. After `db:generate`, verify `_journal.json` `when` is strictly greater than the prior maximum or the migration silently no-ops (CLAUDE.md migration rule).
- **Chain-agnostic principle.** All Polymarket specifics live behind `IPolymarketAdapter`. The use-case and repo know about `marketId`, `side`, `priceBps` — not about Polygon, CLOB, or USDC mechanics.

## Out of scope (this round)

- Voiding / unwinding a paper bet before resolution.
- Multi-currency support (USDC-only; all money is `usdc_cents`).
- Push notifications / receipts when a bet resolves.
- A user-facing performance dashboard page in the mini-app (we expose the endpoint; UI later).
- Cleaning up / deleting the dormant on-chain bet pipeline (separate hygiene pass).

## What "done" looks like

- A user can tap "Place Bet" on a finding card, enter a stake, and see a confirmation that records `(userId, findingId, marketId, side, stakeUsdcCents, entryPriceBps, sharesE6, entryAt)` in `prediction_market_paper_bets`.
- The resolution job runs hourly and resolves bets within an hour of the underlying Polymarket market resolving, populating `outcome`, `payoutUsdcCents`, `realizedPnlUsdcCents`, `resolvedAt`.
- `GET /predictionMarket/paperPerformance` returns total wagered, total P&L, win rate, ROI, and the same metrics sliced by `subject`, `clusterId`, and detector source (`deterministic` vs `llm` — derived from the cluster's `derivedSubject` presence).
- The replay regression test (`be/src/__tests__/predictionMarketsReplay.test.ts`) is untouched; the existing on-chain test suite is untouched.
- `be/STATUS.md` and `fe/privy-auth/status.md` document the new table, routes, and the "broadcast contract unchanged / on-chain pipeline dormant" decision.

## Execution order

Parts are sequential. Part 1 lands schema + repo before Part 2 wires the placement path. Part 3 depends on Part 1's columns. Part 4 (frontend) depends on Part 2's HTTP contract.
