# Error Catalog Reference

Authoritative list of every `ErrorCode` produced by `helpers/errors/errorCatalog.ts::interpretError`. New codes go here BEFORE being added to the `ErrorCode` union or the `PATTERNS` table.

## How matching works

1. Typed-instance fast path: `UnsupportedChainError` instance check returns `unsupported_chain` regardless of message text.
2. Regex sweep against `toErrorMessage(err)` (case-insensitive). First match wins.
3. Default fallback: `internal`.

The `friendly` string is the only text that ever reaches a user. `raw` and `code` stay server-side except for the `internal` tail line that surfaces a truncated `requestId` for support correlation (renderer-side gate).

## Codes

| Code | Pattern | Friendly | Recovery |
|---|---|---|---|
| `amount_too_low` | `AMOUNT_TOO_LOW` / "amount is too small" | "That amount is too small for this route. Try at least $1." | — |
| `amount_too_high` | `AMOUNT_TOO_HIGH` / "exceeds.*max" | "That amount is too large for this route. Try a smaller amount." | — |
| `no_liquidity` | `NO_LIQUIDITY` | "There isn't enough liquidity for this swap right now. Try a smaller amount or a different token." | — |
| `no_route` | `NO_ROUTE` / "route not found" / `RELAY_QUOTE_FAILED` | "Couldn't find a route right now. Please try again in a moment." | — |
| `insufficient_balance` | "insufficient.*balance" / "transfer amount exceeds balance" | "You don't have enough of that token to do that. Tap below to top up." | `Top up` → `/buy` |
| `insufficient_gas` | `AA21` / "prefund" | "Your account is low on gas. Top up to continue." | `Top up` → `/buy` |
| `delegation_required` | "delegation.*required" / "no token delegation" | "You need to grant Aegis permission to spend this token first." | — |
| `delegation_exceeded` | "delegation.*exceeded" / "spend.*limit" | "You've reached your spending limit for this token. Raise it to continue." | `Raise limit` → `/permissions` |
| `rate_limited` | `\b429\b` / "rate.?limit" | "Things are busy right now. Please try again in a moment." | — |
| `unsupported_token` | "unsupported.*token" / "token.*not.*supported" / `UNKNOWN_TOKEN` | "That token isn't supported on this chain yet." | — |
| `insufficient_allowance` | "insufficient.*allowance" / "ERC20:.*allowance" | "You need to approve Aegis to spend that token before continuing." | `Grant permission` → `/permissions` |
| `transfer_history_unavailable` | "transfer.?history.*unavailable" / "history.*unavailable.*chain" | "Transfer history isn't available on this chain right now." | — |
| `service_unavailable` | `\b503\b` / "service unavailable" / `ECONNREFUSED` | "The service is briefly unavailable. Please try again in a moment." | — |
| `recipient_unresolved` | "recipient.*not.*resolved" / "unknown.*handle" | "Couldn't find that recipient. Double-check the @handle or wallet address." | — |
| `stock_market_closed` | `MARKET_CLOSED` / "outside.*trading hours" | "US markets are closed right now. Try again when they reopen." | — |
| `stock_oracle_stale` | `STALE_PRICE` / "oracle.*stale" | "The stock price feed is briefly stale. Try again in a moment." | — |
| `stock_min_size` | `MIN_TRADE_SIZE` / "below.*minimum" | "That trade is below the minimum size. Try a larger amount." | — |
| `stock_pair_inactive` | `PAIR_INACTIVE` | "That stock isn't tradable right now." | — |
| `yield_winner_changed` | "winner.*changed" | "The best pool changed before we could rebalance — no action taken." | — |
| `yield_position_vanished` | "position.*not.*found" | "Looks like you already withdrew — nothing to rebalance." | — |
| `unsupported_chain` | (instance check on `UnsupportedChainError`) | "That chain isn't supported yet." | — |
| `internal` | (default fallback) | "Something went wrong on our side. Please try again." | — |

## Conventions

- **Friendly text is for teenagers.** No jargon, no codes, no hex, no stack traces.
- **Recovery actions only re-enter Aegis.** No URL recoveries — they always point at a slash command or a callback the dispatcher already understands.
- **One pattern per code.** When two patterns might overlap (e.g. `NO_LIQUIDITY` vs `NO_ROUTE`), order them most-specific-first in `PATTERNS`.
- **Renderer behaviour:** the `requestId` "tell us with code <id>" tail line only appears when `errorCode` is missing or `internal`. Known codes already speak for themselves and don't need a support id (spec §2.2).

## Adding a new code

1. Add the entry to this table.
2. Add to the `ErrorCode` union in `errorCatalog.ts`.
3. Append a `PATTERNS` entry. Choose insertion order carefully if your regex could match earlier patterns.
4. Add a unit test in `tests/errorCatalog.test.ts`.
5. If the code introduces a new recovery shape (e.g. a new slash command target), make sure the dispatcher knows that command before shipping.
