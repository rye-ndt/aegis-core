# /buy (Onramp) — Backend Plan

## Goal

Add a `/buy <amount>` slash command that lets a user fund their smart account
with USDC via one of two paths:

1. **Onchain deposit** — user already holds crypto (Binance / Rabby etc.) and
   sends USDC directly to their smart-account address on the active chain.
2. **MoonPay onramp** — user has no crypto; they open the mini-app and pay
   with card / Apple Pay via Privy's `useFundWallet` (MoonPay).

The amount provided by the user is always interpreted as **USDC**.

Flow mirrors `/send` where reasonable, but the "do you already have crypto?"
step is a simple yes/no prompt — **not** an LLM schema field — to keep latency
low and the flow legible.

## Existing surface (do not re-invent)

- `/buy` already exists in `be/src/helpers/enums/intentCommand.enum.ts` as an
  unused placeholder. Wire it up; do not add a new enum value.
- Command → tool routing goes through `commandMappingDB` + `intent.usecase.ts`
  `selectTool()`. Seed a mapping `buy → onramp.buy` tool.
- Telegram handler in `be/src/adapters/implementations/input/telegram/handler.ts`
  owns the per-chat `OrchestratorSession` state machine. Extend it with a new
  stage, don't fork it.
- Mini-app deep linking: `sendMiniAppPrompt()` / `miniAppRequestCache`. Add a
  new request type rather than overloading `sign` / `approve`.
- Smart-account address (deposit target) comes from
  `userProfileRepo.findByUserId(userId).smartAccountAddress`. This is the same
  address users already delegate spending permissions from — same "root
  wallet" the UI labels as "receives funds".
- Active chain info lives only in `be/src/helpers/chainConfig.ts`. Read
  `CHAIN_CONFIG.chainId`, `CHAIN_CONFIG.name`, and (new) the active-chain USDC
  address from there. Never inline chain-specific constants.

## Changes

### 1. Tool manifest: `onramp.buy`

New file: `be/src/adapters/implementations/output/tools/onrampBuy.tool.ts`.

Manifest schema: one required field.

```ts
{
  id: "onramp.buy",
  intent: "buy",
  params: {
    amount: { type: "number", required: true, description: "USDC amount" },
  },
}
```

Register it in the tool registry alongside the other output tools. No
blockchain execution in this tool — it only produces the follow-up prompt
payload (see step 3).

### 2. Command mapping seed

On startup (or via the existing seeding path used for `/send`), ensure a row
exists in `command_tool_mappings` mapping `buy → onramp.buy`.

### 3. Orchestrator session — new post-compile branch

After `compileSchema()` resolves `{ amount }`, the handler currently calls
`buildAndShowConfirmation()` for sign-type tools. Branch on
`manifest.intent === "buy"`:

1. Transition session to a new stage `"onramp_choice"`.
2. Reply with:
   > Do you already have crypto in a wallet like Binance or Rabby?
   Provide two inline-keyboard buttons: **Yes** and **No, buy with card**.
   Callback data encodes `{ kind: "onramp_choice", choice, sessionId }`.
3. Persist `{ amount }` on the session so the callback handler can read it.

Add a `bot.on("callback_query:data")` branch (or extend the existing one) for
`kind === "onramp_choice"`.

#### 3a. `choice === "yes"` — onchain deposit path

- Fetch `smartAccountAddress` from `userProfileRepo`.
- Reply with plain text:
  > Deposit USDC on **{CHAIN_CONFIG.name}** to:
  > `<smartAccountAddress>`
- Include an inline keyboard with a single **Copy address** button. Telegram
  has no native copy action, so implement this as a callback that re-sends
  the bare address in a mono-formatted message (user can long-press to copy).
  Reuse this helper if one exists.
- Clear the session. End of flow.

#### 3b. `choice === "no"` — MoonPay path

- Build a `MiniAppRequest` with **new** `requestType: "onramp"`:
  ```ts
  {
    requestId,
    requestType: "onramp",
    userId,
    payload: {
      amount,                       // number, USDC
      asset: "USDC",
      chainId: CHAIN_CONFIG.chainId,
      walletAddress: smartAccountAddress,
    },
    expiresAt,
  }
  ```
- Store via `miniAppRequestCache.store(request)`.
- Reply with a single inline-keyboard `webApp` button labelled
  **"Buy USDC with card"** pointing at
  `${MINI_APP_URL}?requestId=${requestId}`.
- Clear the session (mini-app owns the rest of the flow).

### 4. MiniAppRequest type extension

In whichever module declares `MiniAppRequest` / `requestType`, add
`"onramp"` as an allowed value and define the payload type above. Keep the
discriminator style already used for `sign` and `approve`.

### 5. No HTTP endpoints

The onramp completes inside Privy's MoonPay widget; the backend does not need
a callback. If later we want to detect deposit completion and reply to the
user, that's a separate feature (watch deposits → Telegram notification) and
out of scope here.

## Why this shape

- **Yes/no as callback buttons, not LLM schema field**: the answer space is
  binary and we already have inline-keyboard plumbing. Running it through
  `compileSchema` would add an LLM round-trip and invite misclassification
  ("binance" → "yes" is obvious to a human but fragile to extract).
- **New `onramp` request type** instead of reusing `sign` / `approve`: the
  mini-app does not sign anything — it opens a MoonPay modal. Overloading
  `sign` would force the frontend to branch on payload shape rather than
  type, which is exactly what the discriminator exists to avoid.
- **Smart-account address as deposit target**: this is the address that
  already holds balances and receives the session-key delegation. Depositing
  to the embedded EOA would leave funds unusable by the bot without an extra
  transfer.
- **No confirmation step for the deposit path**: there is nothing to sign and
  no state to commit on our side. Showing a confirm screen would be noise.

## New conventions introduced

- `MiniAppRequest.requestType = "onramp"` with payload
  `{ amount, asset, chainId, walletAddress }`. Record in `be/status.md`.
- Orchestrator sessions may transition from `compile` directly to an
  intent-specific terminal stage (`onramp_choice`) that resolves via callback
  query rather than text message. Record in `be/status.md` so future intents
  (`/sell`, `/convert`) can follow the same pattern if appropriate.

## Out of scope

- Detecting that an onchain deposit arrived.
- MoonPay webhook handling (Privy/MoonPay own the UX).
- Non-USDC assets. The command is USDC-only by spec.
- Chains where USDC or MoonPay is unavailable. Fuji is acknowledged as a
  testnet limitation; the user will swap to mainnet for real testing.

## Touch list

- `be/src/adapters/implementations/output/tools/onrampBuy.tool.ts` (new)
- Tool registry wire-up (same file that registers other output tools)
- Command-mapping seeding path (match how `send` is seeded)
- `be/src/adapters/implementations/input/telegram/handler.ts`
  — intent branch after compile; new callback handler for `onramp_choice`
- `MiniAppRequest` type module — add `"onramp"` variant
- `be/status.md` — record the new request type and session-stage convention
