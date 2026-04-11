# Frontend Developer Portal — Engineering Brief

> For the new frontend engineer joining the project.
> Read this fully before writing a single line of code.

---

## 1. What this product is

**Aegis** is an AI trading agent that lives on Telegram and an HTTP API. Users chat with it in plain English — "Swap 100 USDC for AVAX" — and the agent figures out what they mean, builds the on-chain transaction, simulates it, asks for confirmation, and executes it. The user never handles a private key.

Under the hood, every user has an **ERC-4337 Smart Contract Account (SCA)** deployed on Avalanche. The agent signs transactions with a **Session Key** that the user pre-authorized. Every executed trade routes a 1% protocol fee to the platform treasury automatically.

---

## 2. Two distinct user types

| Type | What they do |
|---|---|
| **Trader** | Connects wallet via Privy, chats with the AI agent, executes swaps/transfers |
| **Developer** | Registers via Privy, connects wallet, writes and publishes a **Tool Manifest** |

The frontend you are building is for **Developers**. It is a developer portal, not a trading interface.

---

## 3. What a Tool Manifest is — the core concept

The agent's intelligence is generic: it reads user intent and picks the right tool. The tools it can use are registered in a database as **Tool Manifests** — JSON documents that describe:

- **What the tool does** (swap, transfer, contract interaction)
- **What parameters the AI should extract** from the user's message
- **A step pipeline** that the agent executes to produce the raw EVM transaction calldata

When a developer publishes a Tool Manifest, their protocol becomes accessible to every user of the agent. The agent will automatically discover and invoke the tool when a user's intent matches.

**Concrete example:** a developer working at Pangolin DEX writes a manifest that says:
1. "This tool handles swap intents on Pangolin V2"
2. "Call `api.pangolin.exchange/v2/quote` to get calldata"
3. "Pass the calldata to the user's SCA"

After publishing, any user who says "Swap 100 AVAX on Pangolin" will have their intent routed through that manifest — no code change to the agent required.

---

## 4. The developer journey — end to end

```
Developer lands on portal
        │
        ▼
[1] Sign in with Privy
    (email / social / embedded wallet)
        │
        ▼
[2] POST /auth/privy  ──────────────────► Server creates account + deploys SCA
    Receive { token, userId }             (first login = auto-registration)
        │
        ▼
[3] Store JWT in memory / localStorage
        │
        ▼
[4] Connect external wallet (optional)
    For developers who want to set revenueWallet
    — just read the address, no signing needed at this step
        │
        ▼
[5] Fill out the Tool Manifest form
    toolId, category, description, steps, inputSchema, …
        │
        ▼
[6] POST /tools  (Authorization: Bearer <token>)
    Body: the completed Tool Manifest JSON
        │
        ├─── 201 Created ─► Show success: toolId confirmed, indexed: true/false
        ├─── 400 ──────────► Show Zod validation errors inline on the form
        └─── 409 ──────────► "Tool ID already taken" — prompt to change toolId
        │
        ▼
[7] GET /tools  (no auth)
    List the developer's published tool alongside all other active tools
        │
        ▼
[8] DELETE /tools/:toolId  (Authorization: Bearer <token>)
    Deactivate a tool they no longer want live
```

---

## 5. Authentication — what you need to implement

### How it works

Privy handles the browser-side login UI. Once the user authenticates with Privy (email, Google, Twitter, embedded wallet — whatever Privy config exposes), Privy gives the frontend an **access token**. You send that token to the backend, which verifies it against Privy's servers and returns your own JWT.

From that point forward, the Privy token is irrelevant. Your app uses the backend JWT.

### The one auth endpoint

```
POST /auth/privy
Content-Type: application/json

{ "privyToken": "<privy access token>" }
```

Response on success:
```json
{
  "token": "eyJ...",
  "expiresAtEpoch": 1718000000,
  "userId": "uuid-v4"
}
```

- First-time login automatically creates the account — no separate registration step
- `expiresAtEpoch` is a Unix timestamp in **seconds** (not milliseconds). Use it to know when to re-auth
- If Privy is not configured on the server you get `401`; treat this as "service unavailable"

### Attaching the JWT

Every protected request needs:
```
Authorization: Bearer <token>
```

Only `POST /tools` and `DELETE /tools/:toolId` require auth. `GET /tools` is public.

---

## 6. Wallet connection — what it means here

The developer portal connects a wallet for one purpose: letting the developer set a **revenue wallet address**. This is the `revenueWallet` field in the Tool Manifest — the address that will receive their share of protocol fees when their tool is used.

There is no on-chain transaction at this step. You only need to read the connected wallet's address and pre-fill `revenueWallet` in the form.

Use whatever wallet connection library you prefer (Wagmi, RainbowKit, etc.). Privy itself can handle embedded + external wallets if you want to keep the stack unified.

---

## 7. The Tool Manifest form — field by field

This is the main UI work. Each section below maps directly to a field in the JSON you will POST.

### Identity section

| Field | UI element | Constraints |
|---|---|---|
| `toolId` | Text input | Lowercase letters, digits, hyphens only. 3–64 chars. Must be globally unique. Auto-slugify on input (replace spaces → `-`, lowercase). Show live validation. |
| `name` | Text input | 1–100 chars. Human-readable display name. |
| `protocolName` | Text input | 1–100 chars. The DEX or protocol name, e.g. "Pangolin V2". |
| `category` | Select | One of: `erc20_transfer`, `swap`, `contract_interaction` |
| `description` | Textarea | 10–500 chars. This is read by the AI to decide when to use this tool. Write it as "Use this when the user wants to…". Quality here directly affects how often the tool gets invoked. |
| `tags` | Tag input | At least 1 tag. Comma-separated or tag-pill UI. Examples: `swap`, `dex`, `avax`, `pangolin`. |
| `chainIds` | Multi-select or checkboxes | At least 1. Fuji testnet = `43113`, Avalanche mainnet = `43114`. |
| `priority` | Number input (0–100) | Default `0`. Higher wins when multiple tools match the same intent. Most tools should leave this at `0`. |
| `isDefault` | Toggle | Default `false`. Mark `true` only if this should be the fallback for its category when the user doesn't specify a protocol. |

---

### Input Schema section

This is a **JSON Schema** that tells the AI what parameters to extract from the user's message. The field names you define here become available in your step templates as `{{intent.params.fieldName}}`.

The simplest way to let developers write this is a **code editor** (Monaco, CodeMirror) pre-seeded with a template based on the selected category.

Category-based starter templates:

**swap:**
```json
{
  "type": "object",
  "required": ["fromTokenSymbol", "toTokenSymbol", "amountHuman"],
  "properties": {
    "fromTokenSymbol": { "type": "string", "description": "Token to swap from, e.g. USDC" },
    "toTokenSymbol":   { "type": "string", "description": "Token to receive, e.g. AVAX" },
    "amountHuman":     { "type": "string", "description": "Amount in human units, e.g. 100" },
    "slippageBps":     { "type": "number", "description": "Slippage tolerance in basis points" }
  }
}
```

**erc20_transfer:**
```json
{
  "type": "object",
  "required": ["tokenAddress", "amountRaw"],
  "properties": {
    "tokenAddress": { "type": "string", "description": "ERC-20 contract address" },
    "amountRaw":    { "type": "string", "description": "Amount in smallest unit (e.g. wei)" }
  }
}
```

**contract_interaction:**
```json
{
  "type": "object",
  "required": [],
  "properties": {}
}
```

Validate that the input is parseable JSON before allowing submission. No deeper schema validation needed on the frontend.

---

### Steps section

This is the pipeline the agent executes at runtime. Each step is one of five **kinds**. Render this as an ordered list of step cards with an "Add step" button. Steps run top to bottom; the last step must produce the transaction.

#### Template variable cheatsheet (show this in the UI as a reference panel)

| Variable | What it resolves to |
|---|---|
| `{{intent.amountHuman}}` | e.g. `"100"` |
| `{{intent.fromTokenSymbol}}` | e.g. `"USDC"` |
| `{{intent.toTokenSymbol}}` | e.g. `"AVAX"` |
| `{{intent.slippageBps}}` | e.g. `"50"` |
| `{{intent.recipient}}` | Recipient address for transfers |
| `{{intent.params.yourField}}` | Any field from your inputSchema |
| `{{user.scaAddress}}` | The user's Smart Contract Account address |
| `{{steps.stepName.fieldName}}` | Output field from a previous step named `stepName` |

---

#### Step kind: `http_get`

Calls an external URL via GET, extracts values from the JSON response.

| Field | Description |
|---|---|
| `name` | Unique identifier for this step — used to reference its output in later steps |
| `url` | Full URL. Supports `{{...}}` templates. |
| `extract` | Key → JSONPath map. Keys become available as `{{steps.<name>.<key>}}`. Paths: `$.field`, `$.nested.field`, `$.arr[0].field` |

```json
{
  "kind": "http_get",
  "name": "getQuote",
  "url": "https://api.example.com/quote?tokenIn={{intent.fromTokenSymbol}}&from={{user.scaAddress}}",
  "extract": {
    "calldata": "$.tx.data",
    "routerAddress": "$.tx.to",
    "value": "$.tx.value"
  }
}
```

---

#### Step kind: `http_post`

Same as `http_get` but sends a POST with a JSON body.

| Field | Description |
|---|---|
| `name` | Step identifier |
| `url` | Supports `{{...}}` templates |
| `body` | JSON object. String values support `{{...}}` templates. Non-string values (numbers, booleans) pass through as-is. |
| `extract` | Same as `http_get` |

```json
{
  "kind": "http_post",
  "name": "buildTx",
  "url": "https://api.example.com/build",
  "body": {
    "from": "{{user.scaAddress}}",
    "amount": "{{intent.amountHuman}}",
    "tokenIn": "{{intent.fromTokenSymbol}}"
  },
  "extract": {
    "calldata": "$.data",
    "to": "$.to"
  }
}
```

---

#### Step kind: `abi_encode`

Encodes a function call locally — no external HTTP needed. Use this when you know the contract address and ABI and just need to encode the calldata. Always produces `{ to, data, value: "0" }` — so if this is the last step, the transaction is ready.

| Field | Description |
|---|---|
| `name` | Step identifier |
| `contractAddress` | Checksummed EVM address (0x + 40 hex). Validated at registration — will reject the manifest if invalid. |
| `abiFragment.name` | Solidity function name |
| `abiFragment.inputs` | Array of `{ name, type }` — must match function signature order |
| `paramMapping` | Maps each input name → a template string that resolves to the value |

```json
{
  "kind": "abi_encode",
  "name": "encodeSwap",
  "contractAddress": "0xABC123...",
  "abiFragment": {
    "name": "swapExactTokensForTokens",
    "inputs": [
      { "name": "amountIn",  "type": "uint256" },
      { "name": "recipient", "type": "address" }
    ]
  },
  "paramMapping": {
    "amountIn":  "{{intent.params.amountRaw}}",
    "recipient": "{{user.scaAddress}}"
  }
}
```

---

#### Step kind: `calldata_passthrough`

A previous step (e.g. `http_get`) already fetched a complete `to + data + value` triple. This step just forwards them as the transaction.

| Field | Description |
|---|---|
| `name` | Step identifier |
| `to` | Contract address — supports `{{...}}` |
| `data` | Hex calldata — supports `{{...}}` |
| `value` | Native value in wei — supports `{{...}}`. Defaults to `"0"` if omitted. |

```json
{
  "kind": "calldata_passthrough",
  "name": "forward",
  "to":    "{{steps.getQuote.routerAddress}}",
  "data":  "{{steps.getQuote.calldata}}",
  "value": "{{steps.getQuote.value}}"
}
```

---

#### Step kind: `erc20_transfer`

A hardcoded ERC-20 `transfer(address,uint256)` encoder. No config fields — it reads `tokenAddress`, `amountRaw`, and `recipient` automatically from the intent context.

The inputSchema **must** define `tokenAddress` and `amountRaw` in `intent.params`, and the AI must populate `recipient` from the user's message.

```json
{
  "kind": "erc20_transfer",
  "name": "transfer"
}
```

---

### Preflight Preview section (optional)

This controls the human-readable confirmation message the user sees before typing `/confirm`.

| Field | Description |
|---|---|
| `label` | Static label, e.g. `"You are swapping"` |
| `valueTemplate` | Template string, e.g. `"{{intent.amountHuman}} {{intent.fromTokenSymbol}} → {{intent.toTokenSymbol}}"` |

If omitted, the agent shows a generic summary.

---

### Revenue Wallet section (optional)

A single text input for the developer's `0x` Ethereum address. Pre-fill this from the connected wallet. The developer can override it manually.

---

## 8. API reference (only what the frontend touches)

### Auth

```
POST /auth/privy
Body: { "privyToken": string }
Response 200: { token: string, expiresAtEpoch: number, userId: string }
Response 401: { error: "Invalid or expired Privy token" }
```

### Tools

```
POST /tools
Authorization: Bearer <token>
Body: ToolManifest (full JSON)
Response 201: { toolId, id, createdAt, indexed }
Response 400: { error: "Invalid manifest", details: ZodIssue[] }
Response 409: { error: "Tool ID already registered" }

GET /tools?chainId=43113
Response 200: { tools: ToolManifest[] }

DELETE /tools/:toolId
Authorization: Bearer <token>
Response 200: { toolId, deactivated: true }
Response 404: { error: "TOOL_NOT_FOUND: ..." }
```

### Error handling notes

- `400` responses include a `details` array — each entry has `path` (which field failed), `code` (Zod error code), and `message`. Map `path` back to your form fields and show inline errors.
- `409` means the `toolId` slug is taken globally — show the error on the `toolId` field specifically.
- `indexed: false` in the `201` response is not an error — the tool is live and usable; vector search indexing failed but the ILIKE fallback covers it. Show a soft warning, not a failure state.

---

## 9. Validation to implement on the frontend

These match what the backend enforces — catching them before submission gives a better UX.

| Field | Frontend rule |
|---|---|
| `toolId` | `/^[a-z0-9-]+$/`, length 3–64, auto-slugify on input |
| `name` | 1–100 chars, non-empty |
| `protocolName` | 1–100 chars, non-empty |
| `description` | 10–500 chars — show character counter |
| `tags` | At least 1 tag |
| `chainIds` | At least 1 selection |
| `steps` | At least 1 step; last step must be `abi_encode`, `calldata_passthrough`, or `erc20_transfer` (these produce the transaction) |
| `abi_encode.contractAddress` | Must match `/^0x[0-9a-fA-F]{40}$/` |
| `inputSchema` | Must be valid JSON |
| `revenueWallet` | If set, must match `/^0x[0-9a-fA-F]{40}$/` |

---

## 10. Suggested screen structure

```
/login
  └─ Privy login widget
  └─ On success → redirect to /dashboard

/dashboard
  ├─ "My Tools" tab
  │    └─ List of developer's published tools (filter GET /tools by userId if exposed,
  │       or track locally after POST)
  │    └─ Each card: toolId, name, category, chainIds, indexed badge, Deactivate button
  │
  └─ "New Tool" button → /tools/new

/tools/new
  ├─ Step 1 — Identity (toolId, name, category, protocolName, description, tags, chainIds)
  ├─ Step 2 — Input Schema (JSON editor with category-based starter template)
  ├─ Step 3 — Steps pipeline (ordered list of step cards, add/remove/reorder)
  ├─ Step 4 — Settings (priority, isDefault, preflightPreview, revenueWallet)
  └─ Preview panel — live JSON output of the manifest as the developer fills it in
  └─ Submit → POST /tools → success/error state

/tools/:toolId
  └─ Read-only view of a published manifest
  └─ Deactivate button (DELETE /tools/:toolId)
```

---

## 11. What happens after the developer submits

The agent immediately picks up new tools. The next time any user sends an intent that matches the tool's description, category, and chainIds, the agent will route through the manifest. No deployment, no restart.

The discovery works in two layers:
1. **Semantic search (Pinecone)** — the `description`, `name`, `protocolName`, and `tags` are embedded into a vector store. When a user sends a message, the agent embeds the message and finds the closest tools.
2. **ILIKE fallback** — if the vector store is unavailable, the agent falls back to a database text search across the same fields.

This is why the `description` field matters: it is the primary signal the AI uses to decide whether your tool is relevant to a user's message. A vague description means the tool gets missed.

---

## 12. Things to not build (yet)

- Do not build a trading / chat interface — that is Telegram-only for now
- Do not build user registration or login beyond Privy — `/auth/register` and `/auth/login` (email+password) exist but are not the developer portal's concern
- Do not build portfolio or token listing screens — those are for the trading interface
- Do not implement intent confirmation flows — that is Telegram's responsibility

---

## 13. Codebase pointers (if you need to go deeper)

| What | Where |
|---|---|
| All field types and Zod schemas | `src/use-cases/interface/output/toolManifest.types.ts` |
| Registration use-case (what happens on POST /tools) | `src/use-cases/implementations/toolRegistration.usecase.ts` |
| HTTP handler (all routes, request/response shapes) | `src/adapters/implementations/input/http/httpServer.ts` |
| Step execution engine | `src/adapters/implementations/output/solver/manifestSolver/stepExecutors.ts` |
| Template engine (`{{x.y.z}}` resolution) | `src/adapters/implementations/output/solver/manifestSolver/templateEngine.ts` |
| Category enum | `src/helpers/enums/toolCategory.enum.ts` |
| Auth use case (Privy flow) | `src/use-cases/implementations/auth.usecase.ts` |
| Full system overview | `onchain-agent/status.md` |
