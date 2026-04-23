# Capability Convergence Refactor

## Implementation status — 2026-04-23

| Step | Description                                    | Status          |
|------|------------------------------------------------|-----------------|
| 1    | Define ports (interfaces)                      | ✅ Shipped       |
| 2a   | Dispatcher + registry + pending store          | ✅ Shipped       |
| 2b   | Telegram artifact renderer                     | ✅ Shipped       |
| 3    | Migrate `/buy` into `BuyCapability`            | ✅ Shipped       |
| 4    | Migrate LLM fallback into `AssistantChatCapability` | 🟡 Scaffold only — class exists, not registered |
| 5    | Migrate `/send` + manifest-driven capabilities | 🔴 Deferred     |
| 6    | Delete legacy handler branches                 | 🔴 Deferred — partial: `/buy` branches removed |
| 7    | Remove feature flag                            | N/A — flag not needed; progressive fall-through used instead |

**Why paused at Step 4/5 boundary:** `/send` has 13 interdependent methods
and a multi-turn state machine (compile, disambiguation, delegation check,
recipient resolution). Line-by-line porting without a live bot to validate
is high-risk against a working feature. Ship what's verifiable, defer what
needs eyes-on testing. See `be/status.md` "Capability refactor (phase 1)"
for the detailed shipped/deferred breakdown.

## TL;DR

Collapse the three divergent entry flows — **ITool / LLM loop**,
**slash-command → manifest → solver**, and the newly-added **/buy inline
handler branch** — into a single pipeline built from one port + three
strategy axes:

1. `Capability` — strategy interface, one impl per feature.
2. `ParamCollector` — strategy interface, one impl per collection style
   (regex, LLM schema-compile, compile+resolve).
3. `ArtifactRenderer` — one impl per output surface (Telegram first).

The Telegram handler shrinks from ~1146 lines to ~150. No new architecture —
this is applying the hexagonal boundaries that already exist in the repo but
are bypassed by the current top-level flows.

## Why this refactor (the reasoning)

### The actual pain

The "three tool systems" framing is a symptom. The underlying disease is
that `adapters/implementations/input/telegram/handler.ts`:

- Is **1146 lines** with 16 constructor deps and 5 per-chat state maps
  (`orchestratorSessions`, `pendingBuyAmount`, `pendingRecipientNotifications`,
  `conversations`, `sessionCache`).
- Hosts three flow styles inline: `/send` (manifest pipeline), `/buy` (inline
  regex + callback branch), and LLM fallback chat (`handleFallbackChat`).
- Each flow reinvents its own trigger detection, parameter collection, and
  output rendering, with overlap handled ad-hoc (e.g. `if (command)
  this.pendingBuyAmount.delete(chatId)` to prevent cross-flow contamination).

Any new command today adds a new branch to the handler and a new state map.
That scales linearly with commands and exponentially with flow interactions.

### What genuinely diverges (and shouldn't be forced together)

Three axes of variation are **real** across flows:

| Axis            | ITool-style     | Manifest-style          | /buy-style           |
|-----------------|-----------------|-------------------------|----------------------|
| Trigger         | LLM tool-call   | slash + RAG             | slash only           |
| Param collection| LLM JSON        | LLM compile + resolver  | regex                |
| Output          | data-for-LLM    | signable calldata       | UI prompt            |

Each produces genuinely different data. A single `execute()` signature would
make every consumer downstream discriminate on kind anyway. **So do not
unify execution.** Unify the plumbing around execution.

### What unifies cleanly

- **Registration** — one place to list "what the system can do."
- **Dispatch** — one place that decides *which* capability handles an input.
- **Pending-state** — one place for "we asked the user a question and are
  waiting for their reply."
- **Rendering** — one place that turns whatever a capability produces into a
  Telegram side-effect.

Today all four are scattered. After this refactor, each has exactly one home.

### Why polymorphism (and where not to use it)

Apply strategy-pattern polymorphism where **≥3 real implementations exist
today and a credible further one is plausible**:

- `Capability`: 3+ features now, many manifests later.
- `ParamCollector`: 3 styles now (regex, LLM schema, compile+resolve).
- `ArtifactRenderer`: 1 surface (Telegram) now, HTTP/web conceivably next.

Do **not** use class-hierarchy polymorphism for `Artifact` itself. In
TypeScript, a discriminated union with an exhaustive `switch` in the
renderer is shorter, compiler-checked, and easier to debug than
visitor-pattern boilerplate. All behavior is in the renderer; the variants
are inert data.

Do **not** make `Trigger` an interface with `matches()` methods. A plain
`TriggerSpec` object read by the dispatcher's lookup rules is clearer.
Polymorphism is overhead when the axis has only data, not behavior.

### Why it fits the existing hexagonal structure

The repo already splits `use-cases/interface/{input,output}` ports from
`adapters/implementations/{input,output}` adapters. The current entry flows
*bypass* this split — the Telegram handler reaches directly into concrete
services instead of going through a use-case input port. This refactor is
not a new architecture; it's finishing the one that's already there.

## The shape

### Core types

```ts
// use-cases/interface/input/capability.interface.ts

export type TriggerSpec = {
  command?: INTENT_COMMAND;                   // slash command
  llmTool?: IToolDefinition;                  // exposed to the LLM loop
  ragTags?: string[];                         // optional: RAG discovery keywords
};

export type Artifact =
  | { kind: 'llm_data';      data: unknown }
  | { kind: 'sign_calldata'; to: string; data: string; value: string; description: string; autoSign?: boolean }
  | { kind: 'mini_app';      request: MiniAppRequest }
  | { kind: 'chat';          text: string; keyboard?: InlineKeyboard; parseMode?: 'Markdown' };

export type CollectResult<P> =
  | { kind: 'ok';      params: P }
  | { kind: 'ask';     question: string; keyboard?: InlineKeyboard; state: Record<string, unknown> };

export interface Capability<P = unknown> {
  readonly id: string;
  readonly triggers: TriggerSpec;
  collect(ctx: CollectCtx): Promise<CollectResult<P>>;
  run(params: P, ctx: RunCtx): Promise<Artifact>;
}
```

### Dispatcher (the only control-flow home)

```ts
// use-cases/implementations/capabilityDispatcher.usecase.ts

export class CapabilityDispatcher implements ICapabilityDispatcher {
  constructor(
    private readonly registry: ICapabilityRegistry,
    private readonly renderer: IArtifactRenderer,
    private readonly pending: IPendingCollectionStore,
  ) {}

  async handle(input: DispatchInput): Promise<void> {
    const pending = await this.pending.get(input.channelId);
    const cap = pending
      ? this.registry.byId(pending.capabilityId)
      : this.registry.match(input);
    if (!cap) {
      await this.renderer.render({ kind: 'chat', text: "I didn't understand that." }, input.ctx);
      return;
    }

    const result = await cap.collect({ input, resuming: pending?.state, ctx: input.ctx });
    if (result.kind === 'ask') {
      await this.pending.save(input.channelId, { capabilityId: cap.id, state: result.state });
      await this.renderer.render(
        { kind: 'chat', text: result.question, keyboard: result.keyboard },
        input.ctx,
      );
      return;
    }

    await this.pending.clear(input.channelId);
    const artifact = await cap.run(result.params, input.ctx);
    await this.renderer.render(artifact, input.ctx);
  }
}
```

### Param collectors (output port)

```ts
// use-cases/interface/output/paramCollector.interface.ts
export interface ParamCollector<P> {
  collect(input: CollectInput, resuming?: Record<string, unknown>): Promise<CollectResult<P>>;
}
```

Implementations:

- `RegexParamCollector` — declarative regex + validator. Used by
  `BuyCapability` (amount parsing) and any future numeric-only command.
- `LlmSchemaParamCollector` — thin wrapper over the existing
  `IntentUseCase.compileSchema`. Used by capabilities that need
  LLM extraction but not resolution (e.g. pure-data assistant queries if
  they migrate off the ITool loop).
- `CompileResolveParamCollector` — wraps the existing
  `compileSchema → ResolverEngine.resolve` chain. Used by every
  manifest-driven capability (all current `/send`-like flows).
- `CallbackParamCollector` — parses Telegram callback-query payloads.
  Composable with the others (e.g. `/buy` is regex → ask-yes/no → callback).

`compileSchema`, `ResolverEngine`, and `IntentUseCase` do not change; they
become collaborators of collectors rather than being called directly from
the handler.

### Artifact renderer (output port)

```ts
// use-cases/interface/output/artifactRenderer.interface.ts
export interface IArtifactRenderer {
  render(artifact: Artifact, ctx: RenderCtx): Promise<void>;
}
```

`TelegramArtifactRenderer` — one exhaustive switch replacing the scattered
`sendMiniAppPrompt` / `sendMiniAppButton` / `sendApproveButton` / `ctx.reply`
calls:

```ts
switch (artifact.kind) {
  case 'chat':          /* ctx.reply with optional keyboard + parse_mode */
  case 'mini_app':      /* miniAppRequestCache.store + webApp button */
  case 'sign_calldata': /* wrap in SignRequest + store + webApp button */
  case 'llm_data':      /* no-op for Telegram direct input; returned up the loop instead */
}
```

### Pending-collection store (output port)

Replaces `orchestratorSessions`, `pendingBuyAmount`, and
`pendingRecipientNotifications`. One interface, one adapter (in-memory for
now; a Redis impl later is trivial and un-blocks multi-process deployment).

```ts
export interface IPendingCollectionStore {
  get(channelId: string): Promise<PendingCollection | null>;
  save(channelId: string, pending: PendingCollection): Promise<void>;
  clear(channelId: string): Promise<void>;
}
```

## How each current flow migrates

### `BuyCapability` (the escape-hatch, now a first-class citizen)

```ts
class BuyCapability implements Capability<{ amount: number; choice: 'deposit' | 'card' }> {
  id = 'buy';
  triggers = { command: INTENT_COMMAND.BUY };

  constructor(
    private amountCollector: RegexParamCollector<{ amount: number }>,
    private userProfileRepo: IUserProfileDB,
    private chainId: number,
  ) {}

  async collect(ctx) {
    // Stage 1: parse amount (regex) or ask for it.
    // Stage 2: ask yes/no via inline keyboard → CallbackParamCollector.
    // Stage 3: emit resolved params.
  }

  async run(params, ctx): Promise<Artifact> {
    const profile = await this.userProfileRepo.findByUserId(ctx.userId);
    const address = profile?.smartAccountAddress;
    if (!address) return { kind: 'chat', text: 'Smart account not initialised.' };
    if (params.choice === 'deposit') {
      return { kind: 'chat', text: `Deposit on ${CHAIN_CONFIG.name} to ${address}`, keyboard: ... };
    }
    return {
      kind: 'mini_app',
      request: { requestType: 'onramp', userId: ctx.userId, amount: params.amount, asset: 'USDC', chainId: this.chainId, walletAddress: address, ... }
    };
  }
}
```

All `/buy` state (the `pendingBuyAmount` set, the callback regex, the
inline keyboard, the two handlers) lives in **one file**.

### `SendCapability` (wraps the existing manifest pipeline)

```ts
class SendCapability implements Capability<ResolvedSendParams> {
  id = 'send';
  triggers = { command: INTENT_COMMAND.SEND, ragTags: ['send', 'transfer'] };

  constructor(
    private collector: CompileResolveParamCollector<ResolvedSendParams>,
    private intentUseCase: IIntentUseCase,
    private tokenDelegationDB: ITokenDelegationDB,
    private executionEstimator: IExecutionEstimator,
  ) {}

  async collect(ctx) { return this.collector.collect(...); }

  async run(params, ctx): Promise<Artifact> {
    const calldata = await this.intentUseCase.buildRequestBody({ manifest: params.manifest, ... });
    // Existing delegation-check logic moves here verbatim.
    if (delegationSufficient) return { kind: 'sign_calldata', ...calldata, autoSign: true };
    return { kind: 'sign_calldata', ...calldata, autoSign: false };
  }
}
```

`resolverEngine`, `compileSchema`, `buildRequestBody`, and the solver
registry do not change. The capability is a thin facade.

### Manifest-discovered capabilities

A `ManifestCapabilityFactory` turns each active manifest into a Capability at
dispatcher startup (and on manifest-registration). The factory owns the
`requiredFields` → collector wiring. `selectTool`'s RAG logic moves into
`CapabilityRegistry.match()` for the natural-language path.

### `AssistantChatCapability` (the LLM loop)

The current `AssistantUseCase.chat()` and `OpenAIOrchestrator` loop become a
capability whose `triggers` are `{ ragTags: ['*fallback*'] }` and whose
`run()` returns `{ kind: 'llm_data', data: response.reply }`. The Telegram
renderer translates `llm_data` to a chat reply. The ITool registry stays
exactly as it is — the LLM loop still sees ITools; only its outer wrapper
changes.

## File layout

```
use-cases/interface/
  input/
    capability.interface.ts                 NEW   ← Capability, Artifact types, TriggerSpec
    capabilityDispatcher.interface.ts       NEW
  output/
    paramCollector.interface.ts             NEW
    artifactRenderer.interface.ts           NEW
    pendingCollectionStore.interface.ts     NEW
    capabilityRegistry.interface.ts         NEW

use-cases/implementations/
  capabilityDispatcher.usecase.ts           NEW   ← the ~40-line dispatcher
  capabilityRegistry.ts                     NEW   ← Map<id, Capability> + trigger-match index

adapters/implementations/output/
  capabilities/
    buyCapability.ts                        NEW   ← replaces /buy branches in handler.ts
    sendCapability.ts                       NEW   ← wraps manifest pipeline for /send
    manifestCapabilityFactory.ts            NEW   ← turns each active manifest into a Capability
    assistantChatCapability.ts              NEW   ← wraps the LLM loop
    portfolioCapability.ts                  NEW   ← wraps GetPortfolioTool for direct queries
  paramCollector/
    regex.ts                                NEW
    llmSchema.ts                            NEW
    compileResolve.ts                       NEW
    callback.ts                             NEW
  artifactRenderer/
    telegram.ts                             NEW   ← the one exhaustive switch
  pendingCollectionStore/
    inMemory.ts                             NEW

adapters/implementations/input/telegram/
  handler.ts                                SHRINKS (~1146 → ~150)
                                                  - auth gate
                                                  - dispatch to CapabilityDispatcher
                                                  - webApp data / callback routing → dispatcher
  handler.types.ts                          DELETE or slim (OrchestratorSession moves into pending-store)
  handler.messages.ts                       STAYS (confirmation/disambiguation text builders)
  handler.utils.ts                          STAYS (detectStablecoinIntent etc., referenced by collectors)
```

## Migration order (risk-ordered, smallest first)

Each step is independently mergeable and does not break the running system.

### Step 1 — Define ports, no behavior change
Create all the interface files. Add a feature-flag
`USE_CAPABILITY_DISPATCHER` defaulted off. No adapters yet. This is pure
compile-time shape; a reviewer can validate the contracts in isolation.

### Step 2 — Build the dispatcher, renderer, registry, pending-store
Implement the use-case + the Telegram renderer + the in-memory pending
store. Still no capabilities registered. Dispatcher always falls through to
the existing handler when the flag is off.

### Step 3 — Migrate `/buy` first
Smallest surface, newest code, least risk. Extract `BuyCapability` and its
collectors; register it in the dispatcher. When the flag flips on for this
command, the existing `/buy` branches in `handler.ts` are bypassed. Once
verified, delete those branches.

**Why /buy first:** it's the flow that birthed this proposal. If the
abstraction doesn't feel right for the simplest case, stop and reconsider
before touching `/send`.

### Step 4 — Migrate the assistant LLM loop (`handleFallbackChat`)
Second-smallest. The ITool registry and OpenAI orchestrator move behind
`AssistantChatCapability`. No new behavior; just relocating.

### Step 5 — Migrate `/send` and manifest-driven capabilities
Biggest step, highest risk. Split into two commits:

- 5a: Extract `SendCapability` wrapping the current dual-schema flow for
  `/send` specifically. Leaves the RAG/natural-language manifest path
  untouched.
- 5b: `ManifestCapabilityFactory` generates capabilities for every active
  manifest at registration time; move RAG lookup into
  `CapabilityRegistry.match()`.

### Step 6 — Delete the legacy handler branches
After all flows migrate: remove `startCommandSession`, `startLegacySession`,
`initSessionFromTool`, `continueCompileLoop`, `handleFallbackChat`,
`runResolutionPhase`, `handleDisambiguationReply`,
`buildAndShowConfirmation*`, `runDelegationCheck`,
`tryCreateDelegationRequest`, `resolveRecipientHandle`, and the state maps.
`handler.ts` ends up at ~150 lines.

### Step 7 — Remove the feature flag
Flip it on unconditionally, delete the flag read, retire the old path.

## Risks and mitigations

### Risk: breaks `/send` mid-migration
**Mitigation:** feature-flag-gated dispatcher, keep old path live until
Step 6. Integration-test both paths during Steps 3–5.

### Risk: the abstraction doesn't fit manifest-discovered tools
Each manifest has `requiredFields` (human-readable) *and* `inputSchema`
(machine-readable) *and* `finalSchema`. The collector has to know which to
use.
**Mitigation:** `ManifestCapabilityFactory` inspects each manifest and picks
the right collector (dual-schema → `CompileResolveParamCollector`;
single-schema → `LlmSchemaParamCollector`). The complexity stays inside the
factory, not leaked to every capability.

### Risk: pending-state grows unbounded
Telegram users abandon half-finished flows. The in-memory store needs a
TTL.
**Mitigation:** `PendingCollection` carries `expiresAt`; the store sweeps
on access. Match the current 600-second expiry used by mini-app requests.

### Risk: "Capability" becomes a god interface
If collectors, renderers, triggers, and run-time concerns all accrete onto
`Capability`, we'll have traded a god class for a god interface.
**Mitigation:** the interface stays at 4 members (`id`, `triggers`,
`collect`, `run`). Anything else is a collaborator injected via the
constructor. Code-review rule: if `Capability` grows a 5th member, stop and
question it.

### Risk: multi-turn flows (token disambiguation) are fiddly
The current `token_disambig` stage interleaves with `compile`. A naive
`collect → ask → collect` loop needs to model this.
**Mitigation:** `CompileResolveParamCollector` owns the full loop
internally and returns `ask` whenever the resolver throws
`DisambiguationRequiredError`. The dispatcher doesn't need to know about
resolver internals — the whole state machine lives in one collector.

### Risk: subtle behavior drift in the delegation-check path
`runDelegationCheck` auto-signs when delegation is sufficient (autoSign
true on the mini-app request). The migrated `SendCapability.run()` must
preserve this.
**Mitigation:** port line-for-line in Step 5a; no "cleanup" during
migration. Refactor only after parity is proven.

## What this refactor explicitly does NOT do

- **Does not unify ITool and Manifest.** Their contracts (data-for-LLM vs
  calldata-for-signing) are genuinely different. They remain separate
  concepts inside `AssistantChatCapability` and `SendCapability`
  respectively.
- **Does not change the resolver, solver, or manifest runtime.** Those
  systems work and are well-encapsulated. They become collaborators of
  collectors/capabilities.
- **Does not replace the ITool registry.** The LLM loop still needs it;
  only its outer entry wrapper changes.
- **Does not add a new input surface.** Telegram stays the only input
  adapter. The renderer port is defined so a second surface would be
  mechanical, but adding one is out of scope.
- **Does not introduce DI frameworks or decorators.** Plain constructor
  injection via `assistant.di.ts`, matching existing style.

## New conventions introduced

Document in `be/status.md` when this ships:

1. **Every user-facing feature is a `Capability`.** Adding a feature = one
   file implementing the interface + one line registering it. No new
   branches in input adapters, no new per-chat state maps.
2. **Input adapters are thin.** Telegram handler, future HTTP handlers,
   etc. do auth + parse + dispatch. They never own flow logic.
3. **Artifacts are the only output.** A capability returns exactly one
   artifact per invocation. Multiple replies → multiple artifacts →
   multiple calls.
4. **Pending state is centralized.** No per-flow state maps. The
   `PendingCollectionStore` is the only place "we're waiting for the user"
   lives.
5. **Polymorphism is applied to axes with ≥3 implementations.** Don't
   introduce a new port for a one-off.

## Estimated scope

- New files: ~15.
- Modified files: `handler.ts` (shrinks), `assistant.di.ts` (rewires
  construction), `status.md`.
- Deleted: `handler.types.ts` (mostly), handler helper methods covered by
  the dispatcher.
- Total net code: ~neutral. The line count does not drop dramatically;
  what drops is the **number of concepts a reader must hold in their head
  to trace a message from input to output** — currently three divergent
  flows, after: one.

## Open questions to resolve before starting

1. Does `CapabilityRegistry.match()` subsume `selectTool`'s command-map +
   RAG, or call into it? (Proposed: subsume, keeping the DB lookup as a
   detail.)
2. Should `ManifestCapabilityFactory` pre-instantiate a capability per
   manifest at startup, or lazily on first match? (Proposed: lazy cache —
   many manifests, most unused per session.)
3. Does the pending-store need Redis from day one for multi-process
   Telegram bots? (Proposed: no, in-memory first, Redis in a follow-up.)
4. Do we expose capabilities via the HTTP admin surface (list / disable /
   trace last N invocations)? (Proposed: not in this refactor; trivial
   follow-up once the registry exists.)
