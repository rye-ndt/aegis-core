# Errors Status

## Error catalog — 2026-05-04 (P1 foundations)

Per `be/constructions/2026-05-04-result-card-framework.md` §2.

**What was done:**
- New `errorCatalog.ts` exporting `ErrorCode` union + `interpretError(err, { verb, requestId })` returning `InterpretedError { code, friendly, recovery?, raw, requestId }`.
- Pattern table maps regex → code → plain-English `friendly` string (and an optional one-tap `recovery` action). `UnsupportedChainError` is matched by `instanceof` first; everything else is regex-matched against `toErrorMessage(err)`. Default fallback is `code: "internal"`.
- `interpretError` always logs at `error` with `{ err: raw, code, requestId, verb }` before returning. `friendly` is the only string capabilities are allowed to surface to a user — `raw`/`code`/`requestId` stay server-side except where the renderer chooses to expose `requestId.slice(0,8)` on `failed` cards.

**Why:**
- Same shape as the FE's `interpretSignError.ts`, but for **server-side** errors (Relay, Aave, Aster, Ankr, internal) — different surfaces, intentionally separate catalogs.
- Centralising the regex table is the only way to enforce "no raw error leakage" across capabilities. Capabilities never inline `friendly:` text from caught errors; they always go through `interpretError`.

**Conventions to preserve (do not break):**
- New error codes must be added to the `ErrorCode` union AND the `PATTERNS` table here, never inline at a capability site.
- Recovery actions are limited to `{ kind: "command" | "callback", payload }`. URL recoveries are intentionally unsupported — recovery should always re-enter Aegis.
- Log scope is `errorCatalog`. Metadata fields: `code`, `verb`, `requestId`, `err: raw`.
