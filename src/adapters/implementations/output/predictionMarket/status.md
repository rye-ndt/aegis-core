# Prediction Market Adapters — Status

## polymarketAdapter: read-only invariant — 2026-05-21 (Slice E)

**What was done:**

- `PolymarketAdapter` now implements `IPolymarketReadAdapter`. The write surface (`deriveApiKey` / `placeOrder` / `cancelOrder`) was deleted in Slice E-2 along with the corresponding HTTP routes. The adapter never POSTs to Polymarket; the only outbound HTTP is `GET /book?token_id=`, `GET /data/order/:id`, `GET /data/positions?user=`.
- The L2 HMAC helper (`l2Headers`) and `unsealCreds` remain — Polymarket's `/data/order/:id` and `/data/positions?user=` endpoints are L2-protected and require the apiKey/secret/passphrase triplet, even though all three reach the adapter encrypted (`polymarketCredsEnc`) and are unsealed only in-process per call.
- New CI gate: `npm run check:no-clob-secrets` (see `be/scripts/check-no-clob-secrets.sh`) greps for write-path symbols outside this file + the signing-request cache. Adding a new write call site fails the gate.

**Read-only invariant (must hold):**

1. **No outbound POST/DELETE/PUT to Polymarket.** Adapter only fetches.
2. **No method takes a signature.** EIP-712 order signatures are produced FE-side from queued `sign_request`s and submitted directly to `clob.polymarket.com/order` — the BE never holds them.
3. **No method returns or persists CLOB creds.** Creds are written FE-side to Telegram CloudStorage after the FE signs `clob_auth` and POSTs to `/auth/api-key`. The legacy `storePolymarketCreds` BE write path was removed in Slice E-3; existing `polymarket_creds_enc` rows are read-only inputs to HMAC reads. The column drops in a follow-up migration.
4. **No new caller may import `placeOrder` / `cancelOrder` / `deriveApiKey` / `sellOrder`.** Those names no longer exist on the interface; the CI grep gate fails any re-introduction.

**Why HMAC reads survive the "public endpoints" invariant:**

The plan's invariant #4 (`BE only consumes public Polymarket endpoints`) applies at the **type level** — no signing/order/cred-derivation methods on the port. The two surviving read methods (`getOrderStatus`, `getPositions`) hit endpoints that Polymarket requires HMAC on, but those reads are passive observation only: the BE never moves funds, never authorises orders, never opens a position via them. The HMAC payload exists solely to authenticate the read. A future migration to `data-api.polymarket.com` (public) would drop the HMAC, but verifying that URL surface is parity-equivalent is out of Slice E scope.

**New conventions:**

- New adapters that talk to a prediction-market venue MUST split read and write ports. Write methods (signing, order POSTs, cred derivation) belong on a separate port that the BE doesn't implement — those move to the sign queue.
- Any new read method that requires HMAC must take `polymarketCredsEnc` as an arg (no global cred state on the adapter). Decrypted creds must not be cached.
- The CI grep gate is the source of truth for the secret-bearing-token list. Adding a new caller for a documented exception requires updating both the gate's allowlist and `be/STATUS.md`.

## See also

- `be/constructions/2026-05-20-one-click-bet-be.md` — the construction plan that defined Slice D/E/F.
- `be/src/use-cases/interface/predictionMarket/IPolymarketAdapter.ts` — the (now read-only) port.
