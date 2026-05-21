#!/usr/bin/env bash
# Slice E (2026-05-21) — CI gate enforcing the non-custodial invariant.
#
# Fails when any BE source file outside the allowlist references Polymarket
# CLOB secret-bearing tokens or write-path symbols. These should only appear
# in:
#   * the read-only polymarket adapter (HMAC reads needed for /data/order/:id
#     and /data/positions until those endpoints are migrated to a public base)
#   * the signing-request cache layer (where eip712 clob_auth records live
#     transiently until /response resolves)
#   * test files
#
# A hit outside the allowlist almost certainly means a regression: a new
# write path on the BE, a stray apiKey/passphrase log, or a re-imported
# `placeOrder` / `deriveApiKey`.

set -euo pipefail

cd "$(dirname "$0")/.."

# CLOB secret-bearing tokens + the BE-side write-path symbols Slice E removed.
# Generic `apiKey` is too broad — it hits Ankr, Pinecone, OpenAI, Tavily —
# so the gate targets discriminators:
#   * `passphrase` — Polymarket L2 HMAC creds (apiKey/secret/passphrase triplet)
#   * `deriveApiKey` — old L1→L2 BE-side handshake; gone in Slice E
#   * `POLY_API_KEY` / `POLY_PASSPHRASE` — Polymarket HMAC header tokens
#   * `storePolymarketCreds` — the use-case write method Slice E-3 removed
#   * `.placeOrder(` / `.sellOrder(` — Polymarket order POSTs (removed in E-2)
#
# `clob_auth` / `setPolymarketCredsEnc` / `polymarket_creds_enc` are NOT in
# the pattern — they're structural names (sign-request purpose, repo column,
# schema column) that survive Slice E by design. The column drops in a
# follow-up migration; until then existing rows feed HMAC reads.
PATTERN='passphrase|deriveApiKey|POLY_API_KEY|POLY_PASSPHRASE|storePolymarketCreds|\.placeOrder\(|\.sellOrder\('

# Allow the existing HMAC read-only adapter (Slice E carve-out) and the
# signing-request cache surface. Everything else is a hit.
ALLOWLIST_RE='^src/(adapters/implementations/output/predictionMarket/polymarketAdapter\.ts|use-cases/interface/predictionMarket/IPolymarketAdapter\.ts|use-cases/interface/output/cache/signingRequest\.cache\.ts|adapters/implementations/output/cache/.*signingRequest.*\.ts|use-cases/.+__tests__/.+|adapters/implementations/.+__tests__/.+|__tests__/.+)'

# `polymarketOrderDomain.ts` builds the EIP-712 typed-message shape — needs to
# stay (the FE signs against it) but contains no secrets.
ALLOWLIST_FILES_EXTRA='src/use-cases/interface/predictionMarket/polymarketOrderDomain.ts'

# Scan TypeScript source only — markdown docs in status.md files legitimately
# discuss the removed write-path symbols. Exclude build/vendor dirs so a
# stale `dist/` next to `src/` doesn't generate false positives.
hits=$(grep -rnE \
  --include='*.ts' \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=build \
  --exclude-dir=.git \
  "$PATTERN" src 2>/dev/null \
  | grep -vE "$ALLOWLIST_RE" \
  | grep -vF "$ALLOWLIST_FILES_EXTRA" \
  || true)

if [[ -n "$hits" ]]; then
  echo "ERROR: CLOB-secret / write-path symbol found outside the allowlist." >&2
  echo "       Pattern: $PATTERN" >&2
  echo "       Allowed: read-only polymarketAdapter.ts, signing-request cache, tests." >&2
  echo "" >&2
  echo "$hits" >&2
  echo "" >&2
  echo "If a new caller is genuinely justified, update scripts/check-no-clob-secrets.sh" >&2
  echo "with a documented exception (and add a comment in be/STATUS.md)." >&2
  exit 1
fi

echo "check:no-clob-secrets — OK"
