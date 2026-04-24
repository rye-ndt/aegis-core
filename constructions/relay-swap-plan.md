# Relay Swap — Backend Plan

Intent-based cross-chain + same-chain swaps powered by relay.link. Autonomous
execution via the session key stored in the user's Telegram CloudStorage (signed
inside the mini app; backend never holds the key).

Commands as decisions already locked in (see chat): option **(a)** — a
`SwapCapability` that reuses the `/send` compile/resolve helpers but calls a
new `RelaySwapTool` directly instead of going through `ExecuteIntentTool` +
solver registry. No /confirm gate. Per-step (no batching). Aegis-Guard interceptor
mirrors `SendCapability`.

## 1. Scope

- New Telegram command: `/swap`.
- Inputs gathered like `/send`: `fromTokenSymbol`, `toTokenSymbol`,
  `readableAmount`, optional `fromChain`, `toChain`.
- Same-chain and cross-chain both supported from day one.
- Execution: fetch a quote from relay.link → push each returned transaction
  step to the mini app as a discrete `SignRequest` with `autoSign: true` →
  mini app signs with the session key → backend records the tx hash and
  emits the next step until the list is exhausted.
- Aegis-Guard: on the `fromToken`, reuse `ExecutionEstimator` + `ITokenDelegationDB`
  the exact way `SendCapability` does; if the current delegation is short,
  emit a `reapproval` `ApproveRequest` **before** starting the swap.
- No backend signing. No batching. No new tool-registry types.

## 2. Files touched / added

### New

| Path | Purpose |
| ---- | ------- |
| `be/src/adapters/implementations/output/tools/system/relaySwap.tool.ts` | `RelaySwapTool implements ITool` — forms the Relay quote body, calls `relay.link/quote`, pushes the returned steps into the mini-app request queue one-at-a-time. |
| `be/src/adapters/implementations/output/capabilities/swapCapability.ts` | `SwapCapability implements Capability` — fresh-text → `compileSchema` → `ResolverEngine` → disambiguation → Aegis-Guard interceptor → `RelaySwapTool.execute`. Thin: delegates all shared helpers. |
| `be/src/adapters/implementations/output/capabilities/swap.messages.ts` | Capability-local message builders (`buildSwapGatherPrompt`, `buildSwapReapprovalCopy`, `buildSwapStartedCopy`). Mirrors `send.messages.ts`. |
| `be/src/adapters/implementations/output/relay/relayClient.ts` | Thin fetch wrapper around `${RELAY_API_URL}/quote` (and `/execute/status` for post-submission polling — optional, v2). One file, no abstraction layer. |
| `be/constructions/relay-swap-plan.md` | This file. |

### Modified

| Path | Change |
| ---- | ------ |
| `be/src/helpers/enums/intentCommand.enum.ts` | Add `SWAP = "/swap"`. No code calls the enum values by index, so ordering is free. |
| `be/src/helpers/chainConfig.ts` | Add `relayEnabled: boolean` flag per `CHAIN_REGISTRY` entry. Export `RELAY_SUPPORTED_CHAIN_IDS: number[]` derived from the registry. **This is the single source of truth** — no inline chain id lists anywhere else. |
| `be/src/use-cases/interface/output/cache/miniAppRequest.types.ts` | No new `RequestType`. Swap uses the existing `SignRequest` one-step-at-a-time. (**If** per-step UX proves bad in testing, we can add a `SwapRequest` variant — kept out of v1 for cardinality.) |
| `be/src/adapters/inject/assistant.di.ts` | Build `RelaySwapTool` inside the tool registry factory; register `SwapCapability` with the dispatcher. Wire its `SendCapabilityDeps`-shaped deps (reuse the singleton instances already created for `/send`). |
| `be/src/adapters/implementations/output/systemToolProvider.concrete.ts` | Add `RelaySwapTool` to `getTools()` **only if** we also want the LLM free-text path to hit Relay directly. Default: register only in the command path (via the capability) to keep LLM tool-calling deterministic. **Decision locked: do not add to `SystemToolProviderConcrete` in v1.** |
| `be/.env.example` | `RELAY_API_URL`, optional `RELAY_API_KEY` (Relay's public endpoint is keyless today — keep the var for parity with other providers). |
| `be/status.md` | New `## /swap — 2026-04-24` section documenting flow + conventions. |

## 3. Data flow

```
Telegram: /swap 20 usdc to eth on base
    │
    ▼
CapabilityDispatcher.dispatch
    │ match command=/swap → SwapCapability
    ▼
SwapCapability.collect
    │ 1. selectTool (reuses command_tool_mappings — see §5 for manifest shape)
    │ 2. compileSchema   (fills fromTokenSymbol, toTokenSymbol, readableAmount,
    │                     fromChainSymbol?, toChainSymbol?)
    │ 3. ResolverEngine.resolve — dual-schema path
    │ 4. disambiguation loop if multiple token candidates
    │ 5. Aegis-Guard interceptor on fromToken (see §6)
    ▼
SwapCapability.run(params)
    │ a. RelaySwapTool.execute({ tokenIn, tokenOut, amountRaw, fromChainId, toChainId, user, recipient })
    │       → POST relay.link/quote, returns { steps: [{ items: [{ data, to, value }, ...] }, ...] }
    │ b. Flatten steps[*].items[*] into a tx queue
    │ c. For each tx in queue:
    │      - emit { kind: 'sign_calldata', autoSign: true, … } (becomes SignRequest in Redis)
    │      - WAIT for SignResponse { txHash } via signingRequestCache resolve
    │      - record txHash; if rejected, abort the remaining queue
    │ d. Emit final chat artifact: "Swap complete — tx1, tx2, …"
    ▼
Mini app (SignHandler) signs each step with session key (unchanged)
```

Key subtlety: the existing `ctx.emit({ kind: 'sign_calldata', ... })` pushes a
`SignRequest` into the mini-app queue **but does not wait for completion**.
We need to wait per step. Two options, pick **(ii)**:

- (i) Fire-and-forget; the mini app polls for new requests between signs. Problem:
  nothing triggers the next step — backend is no longer running.
- (ii) **Await inside `RelaySwapTool`.** Use `ISigningRequestCache` /
  `signingRequest` use case — there is already a `waitForResponse(requestId, timeoutMs)`
  pattern in place for `/sign`. The tool creates one signing request per step,
  awaits the resolution, then proceeds. No new infra needed beyond wiring
  `ISigningRequestUseCase` into `RelaySwapTool` constructor.

**Confirm during implementation**: if `ISigningRequestUseCase` lacks a
`waitFor(requestId)`, we add it as part of this feature rather than
re-implementing polling.

## 4. `RelaySwapTool`

```ts
// be/src/adapters/implementations/output/tools/system/relaySwap.tool.ts

const RELAY_API_URL = process.env.RELAY_API_URL ?? 'https://api.relay.link';

const InputSchema = z.object({
  tokenIn: z.string(),         // resolved address (0x… or 'native' marker)
  tokenOut: z.string(),
  amountRaw: z.string(),       // wei string, per codebase convention
  fromChainId: z.number().int(),
  toChainId: z.number().int(),
  user: z.string(),            // SCA address
  recipient: z.string(),       // defaults to user upstream
});

class RelaySwapTool implements ITool {
  constructor(
    private readonly relayClient: IRelayClient,
    private readonly signingRequestUseCase: ISigningRequestUseCase,
  ) {}

  definition(): IToolDefinition { /* name: 'relay_swap', JSON schema */ }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const p = InputSchema.parse(input);
    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(p.fromChainId)) return { success: false, error: 'UNSUPPORTED_ORIGIN_CHAIN' };
    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(p.toChainId))   return { success: false, error: 'UNSUPPORTED_DEST_CHAIN' };

    const quote = await this.relayClient.getQuote({
      user: p.user,
      recipient: p.recipient,
      originChainId: p.fromChainId,
      destinationChainId: p.toChainId,
      originCurrency: p.tokenIn,
      destinationCurrency: p.tokenOut,
      amount: p.amountRaw,
      tradeType: 'EXACT_INPUT',
    });

    const txs = quote.steps.flatMap(s => s.items.map(item => item.data)); // { to, data, value }
    const txHashes: string[] = [];
    for (const tx of txs) {
      const res = await this.signingRequestUseCase.createAndWait({
        userId: p.user /*TBD: pass userId in*/,
        to: tx.to, value: tx.value ?? '0', data: tx.data,
        description: `Relay swap step ${txHashes.length + 1}/${txs.length}`,
        autoSign: true,
      });
      if (res.rejected) return { success: false, error: 'USER_REJECTED', data: { txHashes } };
      txHashes.push(res.txHash!);
    }
    return { success: true, data: { txHashes, quote: { fees: quote.fees, outputAmount: quote.details?.currencyOut?.amount } } };
  }
}
```

(Interface shape for `createAndWait` may already exist under a different name —
check `be/src/use-cases/implementations/signingRequest.usecase.ts` before
adding.)

## 5. `ToolManifest` for `/swap`

Even though the terminal step bypasses the solver registry, we still want the
compile + resolver path, which reads `manifest.requiredFields`. We keep a
manifest seed-loaded at startup (same mechanism `/send` uses), pointing at a
`"toolId": "system.relay_swap"` marker. `SwapCapability` short-circuits the
solver lookup at the `run()` step.

```jsonc
{
  "toolId": "system.relay_swap",
  "name": "Relay Swap",
  "category": "swap",
  "requiredFields": {
    "fromTokenSymbol":  "fromTokenSymbol",
    "toTokenSymbol":    "toTokenSymbol",
    "readableAmount":   "readableAmount"
  },
  "inputSchema": {
    "type": "object",
    "properties": {
      "fromTokenSymbol":  { "type": "string" },
      "toTokenSymbol":    { "type": "string" },
      "readableAmount":   { "type": "string" },
      "fromChainSymbol":  { "type": "string", "description": "e.g. 'base', 'avalanche' — optional, defaults to current chain" },
      "toChainSymbol":    { "type": "string" }
    },
    "required": ["fromTokenSymbol", "toTokenSymbol", "readableAmount"]
  }
}
```

`fromChainSymbol` / `toChainSymbol` resolution: add a tiny pure helper
`resolveChainSymbol(sym?: string): number` in `chainConfig.ts` that falls
back to `CHAIN_CONFIG.chainId` when absent. Lives in the only file allowed
to reference chain ids.

## 6. Aegis-Guard interceptor (clean, standalone)

Extract the Aegis check currently inlined in `SendCapability.run` into a
helper so `SwapCapability` can call it without copy-pasting:

```
be/src/use-cases/implementations/aegisGuardInterceptor.ts

checkTokenDelegation({
  userId, fromToken, amountHuman, amountRaw,
  tokenDelegationDB, executionEstimator,
}) → { ok: true } | { ok: false, reapprovalRequest: ApproveRequest, displayMessage: string }
```

Update `SendCapability` to call `checkTokenDelegation` instead of its inline
block — this is the "clean code here so I can read it later" ask. Zero behavior
change for `/send`; a real shared helper is born.

`SwapCapability.run` calls `checkTokenDelegation` on the `fromToken` **before**
calling `RelaySwapTool.execute`. If `ok: false`, emit `{ kind: 'mini_app',
request: reapprovalRequest, buttonText: "Approve More" }` and abort without
touching Relay. The user re-approves, runs `/swap` again.

(v2 could chain re-approval → swap in one flow; v1 keeps it two-shot to match
existing `/send` UX.)

## 7. `SwapCapability` structure

Near-line-for-line copy of `SendCapability`, with these deltas:

- Drop the `@handle` recipient resolution branch (swaps are self-recipient).
- After `compileSchema`, resolve `fromChainSymbol` / `toChainSymbol` → numeric
  chain ids via `resolveChainSymbol`. Validate both against
  `RELAY_SUPPORTED_CHAIN_IDS` and abort with a clear message otherwise.
- Skip `buildRequestBody` (Relay produces calldata, not us).
- Skip `/confirm` gate — `run()` goes directly to Aegis-Guard check →
  `RelaySwapTool.execute`.
- Skip `tryEmitDelegationRequest` (that is `/send`-specific zerodev delegation
  plumbing; Aegis-Guard covers the equivalent cap for us).

Because the shared bits (compile-loop, disambiguation, state serialisation) are
already in `send.utils.ts`, lift them into `capabilities/shared/` as pure
functions and import from both. No new class hierarchy.

## 8. Tests

Add to `be/tests/`:

- `swapCapability.collect.test.ts` — happy path (same-chain), missing field,
  disambiguation, unsupported-chain rejection.
- `swapCapability.run.test.ts` — stub `IRelayClient` returning two steps
  (approval + swap). Assert two `createAndWait` calls, both `autoSign: true`.
  Assert `reapprovalRequest` emitted when Aegis-Guard says not-ok.
- `aegisGuardInterceptor.test.ts` — extracted-helper parity against the current
  `SendCapability.run` autosign branch.

Run via `npx tsx --test tests/*.test.ts`.

## 9. Open items to decide at implementation time

1. **`ISigningRequestUseCase.createAndWait`** — if a `waitFor` doesn't exist,
   add it. Back it with a Redis pub/sub or a simple poll loop over
   `ISigningRequestCache` (existing `sign_req:{id}` key). Pick pub/sub only if
   already wired; otherwise a 500ms poll with 5-minute timeout is fine.
2. **Relay currency encoding** — Relay expects `originCurrency` as either a
   contract address or `'0x0000…0000'` for native. Map our `ITokenRecord.isNative`
   to that zero-address. Centralise in `relayClient.ts`.
3. **Slippage / `tradeType`** — v1: always `EXACT_INPUT`. Slippage passed as
   Relay's default; expose as an env var `RELAY_MAX_SLIPPAGE_BPS` once users
   ask.
4. **Gas sponsorship** — ZeroDev paymaster is already wired in
   `ZerodevUserOpExecutor`. The mini app `createSessionKeyClient` uses its own
   `VITE_PAYMASTER_URL`. For `autoSign: true` flows the mini app handles gas;
   backend makes no paymaster decision per swap.
5. **Status polling (Relay)** — Relay returns `{ txHash, chainId }` per step.
   We record them and stop. Cross-chain "destination fill" polling is a v2
   follow-up (Relay exposes `/intents/status/v2`). Out of v1 scope.

## 10. Out of scope (v1)

- Slippage control UI.
- Destination-fill confirmation for cross-chain (see §9.5).
- LLM free-text path (no `SystemToolProviderConcrete` registration).
- Batching multiple steps into one UserOp.
- Limit orders / TWAP via Relay.

## 11. Migration notes

- No DB schema changes.
- No migration to run.
- New env vars added to `.env.example` only; defaults let the tool work against
  Relay's public endpoint without keys.
