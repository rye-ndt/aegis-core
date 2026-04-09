# Onchain Agent — Implementation Plan

> Authored: 2026-04-09  
> Status: Awaiting implementation  
> Implements: Phase 2 + Phase 3 from `status.md`, full architecture from `thesis.md`

---

## 0. Context Summary

The codebase is a Hexagonal Architecture Telegram bot. Phase 1 (purge) is complete. The goal is to evolve it into an **intent-based AI trading agent on Avalanche** using ERC-4337 Smart Contract Accounts and Session Keys.

**Tech stack preserved:**
- TypeScript 5.3, Node.js strict mode
- Drizzle ORM + PostgreSQL (`pg` driver)
- Telegram (`grammy`) + HTTP API (native `http`)
- Manual DI container in `src/adapters/inject/`

**Tech stack changes:**
- Replace OpenAI orchestrator → Anthropic (`claude-sonnet-4-6`)
- Add viem/ethers for on-chain calls
- Add `@anthropic-ai/sdk` for LLM

---

## 1. New Database: `aether_intent`

Create a new PostgreSQL database named **`aether_intent`** (separate from any prior database).

Connection string format:
```
postgres://localhost:5432/aether_intent
```

Update `DATABASE_URL` env var and the default in `src/adapters/inject/assistant.di.ts`.

### 1.1 Full Schema

All tables live in `src/adapters/implementations/output/sqlDB/schema.ts`.  
All `*_at_epoch` columns store **seconds**, not milliseconds (use `newCurrentUTCEpoch()`).  
All `id` columns use `newUuid()` (UUIDv4).

---

#### Table: `users` (existing — keep as-is)

```typescript
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  email: text("email").notNull().unique(),
  status: text("status").notNull(),   // USER_STATUSES enum
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

---

#### Table: `telegram_sessions` (existing — keep as-is)

```typescript
export const telegramSessions = pgTable("telegram_sessions", {
  telegramChatId: text("telegram_chat_id").primaryKey(),
  userId: uuid("user_id").notNull(),
  expiresAtEpoch: integer("expires_at_epoch").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
```

---

#### Table: `conversations` (existing — keep as-is)

```typescript
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),   // CONVERSATION_STATUSES enum
  summary: text("summary"),
  intent: text("intent"),
  flaggedForCompression: boolean("flagged_for_compression").notNull().default(false),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

---

#### Table: `messages` (existing — keep as-is)

```typescript
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(),            // MESSAGE_ROLE enum
  content: text("content").notNull(),
  toolName: text("tool_name"),
  toolCallId: text("tool_call_id"),
  toolCallsJson: text("tool_calls_json"),  // JSON of tool calls array
  compressedAtEpoch: integer("compressed_at_epoch"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
```

---

#### Table: `user_profiles` (existing — extend with session key fields)

```typescript
export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey(),
  telegramChatId: text("telegram_chat_id"),
  smartAccountAddress: text("smart_account_address"),  // ERC-4337 SCA address
  eoaAddress: text("eoa_address"),                      // underlying EOA (if any)
  sessionKeyAddress: text("session_key_address"),       // bot's delegated session key address
  sessionKeyScope: text("session_key_scope"),           // JSON: { maxAmountPerTx, allowedTokens, expiresAtEpoch }
  sessionKeyStatus: text("session_key_status"),         // SESSION_KEY_STATUSES enum: active | revoked | expired
  sessionKeyExpiresAtEpoch: integer("session_key_expires_at_epoch"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

---

#### Table: `token_registry` (NEW)

Maps human-readable symbols to on-chain addresses. Acts as the safety barrier against token spoofing.

```typescript
export const tokenRegistry = pgTable("token_registry", {
  id: uuid("id").primaryKey(),
  symbol: text("symbol").notNull(),          // "USDC", "AVAX", "WAVAX"
  name: text("name").notNull(),              // "USD Coin"
  chainId: integer("chain_id").notNull(),    // 43113 = Fuji, 43114 = Mainnet
  address: text("address").notNull(),        // "0xB97..."
  decimals: integer("decimals").notNull(),   // 6 for USDC, 18 for AVAX
  isNative: boolean("is_native").notNull().default(false),  // true for AVAX
  isVerified: boolean("is_verified").notNull().default(false),
  logoUri: text("logo_uri"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
// Unique constraint: (symbol, chain_id)
```

---

#### Table: `intents` (NEW)

Stores the raw user message and its parsed structured form before execution.

```typescript
export const intents = pgTable("intents", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  messageId: uuid("message_id").notNull(),     // the user message that triggered this
  rawInput: text("raw_input").notNull(),        // "Buy $100 of AVAX"
  parsedJson: text("parsed_json").notNull(),    // JSON: IntentPackage (see §3.1)
  status: text("status").notNull(),             // INTENT_STATUSES enum
  rejectionReason: text("rejection_reason"),    // set if status = rejected
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

---

#### Table: `intent_executions` (NEW)

One row per on-chain execution attempt. An intent may be attempted multiple times (e.g., retry after gas bump).

```typescript
export const intentExecutions = pgTable("intent_executions", {
  id: uuid("id").primaryKey(),
  intentId: uuid("intent_id").notNull(),
  userId: uuid("user_id").notNull(),
  smartAccountAddress: text("smart_account_address").notNull(),
  solverUsed: text("solver_used").notNull(),        // e.g. "trader_joe_v2_solver"
  simulationPassed: boolean("simulation_passed").notNull(),
  simulationResult: text("simulation_result"),      // JSON: SimulationReport (see §3.2)
  userOpHash: text("user_op_hash"),                 // ERC-4337 UserOperation hash
  txHash: text("tx_hash"),                          // final on-chain tx hash
  status: text("status").notNull(),                 // EXECUTION_STATUSES enum
  errorMessage: text("error_message"),
  gasUsed: text("gas_used"),                        // bigint as string
  feeAmount: text("fee_amount"),                    // protocol fee collected, in token decimals
  feeToken: text("fee_token"),                      // address of fee token
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

---

#### Table: `tool_manifests` (NEW)

The on-chain/off-chain registry of Solver tools. Supports the Decentralized Tool Registry described in the thesis.

```typescript
export const toolManifests = pgTable("tool_manifests", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),         // "trader_joe_v2_solver"
  displayName: text("display_name").notNull(),   // "Trader Joe V2 Swap"
  description: text("description").notNull(),    // used by semantic router + LLM
  version: text("version").notNull(),            // "1.0.0"
  solverType: text("solver_type").notNull(),     // "static" | "restful"
  endpointUrl: text("endpoint_url"),             // for restful solvers
  inputSchema: text("input_schema").notNull(),   // JSON Schema string
  outputSchema: text("output_schema").notNull(), // JSON Schema string
  contributorAddress: text("contributor_address"), // wallet for fee split
  revShareBps: integer("rev_share_bps").notNull().default(0),  // basis points (e.g. 2000 = 20%)
  isActive: boolean("is_active").notNull().default(true),
  chainIds: text("chain_ids").notNull(),         // JSON array of supported chainIds
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
```

---

#### Table: `fee_records` (NEW)

Audit trail for every protocol fee collected. One row per execution that resulted in a fee.

```typescript
export const feeRecords = pgTable("fee_records", {
  id: uuid("id").primaryKey(),
  executionId: uuid("execution_id").notNull(),
  userId: uuid("user_id").notNull(),
  totalFeeBps: integer("total_fee_bps").notNull(),        // e.g. 100 = 1%
  platformFeeBps: integer("platform_fee_bps").notNull(),  // platform portion
  contributorFeeBps: integer("contributor_fee_bps").notNull(), // solver contributor portion
  feeTokenAddress: text("fee_token_address").notNull(),
  feeAmountRaw: text("fee_amount_raw").notNull(),         // bigint as string
  platformAddress: text("platform_address").notNull(),    // treasury address
  contributorAddress: text("contributor_address"),        // null if no contributor
  txHash: text("tx_hash").notNull(),
  chainId: integer("chain_id").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
```

---

### 1.2 New Enums

Add to `src/helpers/enums/`:

**`intentStatus.enum.ts`**
```typescript
export enum INTENT_STATUSES {
  PENDING = "pending",
  SIMULATION_FAILED = "simulation_failed",
  AWAITING_CONFIRMATION = "awaiting_confirmation",
  CONFIRMED = "confirmed",
  EXECUTING = "executing",
  COMPLETED = "completed",
  FAILED = "failed",
  REJECTED = "rejected",
}
```

**`executionStatus.enum.ts`**
```typescript
export enum EXECUTION_STATUSES {
  PENDING = "pending",
  SIMULATING = "simulating",
  SIMULATION_FAILED = "simulation_failed",
  SUBMITTING = "submitting",
  SUBMITTED = "submitted",
  CONFIRMED = "confirmed",
  FAILED = "failed",
}
```

**`sessionKeyStatus.enum.ts`**
```typescript
export enum SESSION_KEY_STATUSES {
  ACTIVE = "active",
  REVOKED = "revoked",
  EXPIRED = "expired",
  PENDING = "pending",
}
```

**`solverType.enum.ts`**
```typescript
export enum SOLVER_TYPE {
  STATIC = "static",
  RESTFUL = "restful",
}
```

---

## 2. Repository Structure

New files to create (relative to `src/`). Modified files are marked `[MOD]`.

```
src/
│
├── telegramCli.ts                                          [MOD] add intent handler
│
├── use-cases/
│   ├── implementations/
│   │   ├── assistant.usecase.ts                            [MOD] Phase 2: swap orchestrator
│   │   ├── auth.usecase.ts                                 [MOD] Phase 2: deploy SCA on register
│   │   └── intent.usecase.ts                               [NEW] parse → simulate → execute
│   │
│   └── interface/
│       ├── input/
│       │   ├── assistant.interface.ts                      [keep]
│       │   ├── auth.interface.ts                           [keep]
│       │   └── intent.interface.ts                         [NEW]
│       │
│       └── output/
│           ├── orchestrator.interface.ts                   [keep]
│           ├── tool.interface.ts                           [keep]
│           ├── webSearch.interface.ts                      [keep]
│           ├── sqlDB.interface.ts                          [MOD] add new repos
│           ├── blockchain/
│           │   ├── smartAccount.interface.ts               [NEW]
│           │   ├── sessionKey.interface.ts                 [NEW]
│           │   ├── userOperation.interface.ts              [NEW]
│           │   └── paymaster.interface.ts                  [NEW]
│           ├── solver/
│           │   ├── solver.interface.ts                     [NEW]
│           │   └── solverRegistry.interface.ts             [NEW]
│           ├── simulator.interface.ts                      [NEW]
│           ├── tokenRegistry.interface.ts                  [NEW]
│           └── repository/
│               ├── user.repo.ts                            [keep]
│               ├── conversation.repo.ts                    [keep]
│               ├── message.repo.ts                         [keep]
│               ├── telegramSession.repo.ts                 [keep]
│               ├── userProfile.repo.ts                     [NEW]
│               ├── tokenRegistry.repo.ts                   [NEW]
│               ├── intent.repo.ts                          [NEW]
│               ├── intentExecution.repo.ts                 [NEW]
│               ├── toolManifest.repo.ts                    [NEW]
│               └── feeRecord.repo.ts                       [NEW]
│
├── adapters/
│   ├── inject/
│   │   └── assistant.di.ts                                 [MOD] wire all new components
│   │
│   └── implementations/
│       ├── input/
│       │   ├── http/
│       │   │   └── httpServer.ts                           [MOD] add /intent endpoints
│       │   └── telegram/
│       │       ├── bot.ts                                  [keep]
│       │       └── handler.ts                              [MOD] add intent flow + preflight UI
│       │
│       └── output/
│           ├── orchestrator/
│           │   ├── openai.ts                               [keep — used for intent parsing]
│           │   └── anthropic.ts                            [NEW] AnthropicOrchestrator
│           │
│           ├── blockchain/
│           │   ├── viemClient.ts                           [NEW] shared viem public + wallet clients
│           │   ├── smartAccount.adapter.ts                 [NEW] deploy SCA via SessionKeyFactory
│           │   ├── sessionKey.adapter.ts                   [NEW] grant/revoke session keys
│           │   ├── userOperation.builder.ts                [NEW] build + sign UserOperations
│           │   └── paymaster.adapter.ts                    [NEW] Paymaster service client
│           │
│           ├── solver/
│           │   ├── solverRegistry.ts                       [NEW] maps intent action → solver
│           │   ├── static/
│           │   │   └── claimRewards.solver.ts              [NEW] example static solver
│           │   └── restful/
│           │       └── traderJoe.solver.ts                 [NEW] 1inch/TraderJoe quote + calldata
│           │
│           ├── simulator/
│           │   └── rpc.simulator.ts                        [NEW] eth_call simulation + result parsing
│           │
│           ├── intentParser/
│           │   └── anthropic.intentParser.ts               [NEW] LLM → IntentPackage JSON
│           │
│           ├── tokenRegistry/
│           │   └── db.tokenRegistry.ts                     [NEW] reads from token_registry table
│           │
│           ├── resultParser/
│           │   └── tx.resultParser.ts                      [NEW] tx receipt + events → human string
│           │
│           ├── webSearch/
│           │   └── tavily.webSearchService.ts              [keep]
│           │
│           ├── toolRegistry.concrete.ts                    [keep]
│           ├── tools/
│           │   ├── webSearch.tool.ts                       [keep]
│           │   ├── executeIntent.tool.ts                   [NEW] tool the LLM calls to trigger execution
│           │   └── getPortfolio.tool.ts                    [NEW] reads SCA balances on-chain
│           │
│           └── sqlDB/
│               ├── drizzlePostgres.db.ts                   [keep]
│               ├── drizzleSqlDb.adapter.ts                 [MOD] add new repos as properties
│               ├── schema.ts                               [MOD] add new tables
│               └── repositories/
│                   ├── user.repo.ts                        [keep]
│                   ├── conversation.repo.ts                [keep]
│                   ├── message.repo.ts                     [keep]
│                   ├── telegramSession.repo.ts             [keep]
│                   ├── userProfile.repo.ts                 [NEW]
│                   ├── tokenRegistry.repo.ts               [NEW]
│                   ├── intent.repo.ts                      [NEW]
│                   ├── intentExecution.repo.ts             [NEW]
│                   ├── toolManifest.repo.ts                [NEW]
│                   └── feeRecord.repo.ts                   [NEW]
│
└── helpers/
    ├── enums/
    │   ├── messageRole.enum.ts                             [keep]
    │   ├── statuses.enum.ts                                [keep]
    │   ├── toolType.enum.ts                                [MOD] add EXECUTE_INTENT, GET_PORTFOLIO
    │   ├── intentStatus.enum.ts                            [NEW]
    │   ├── executionStatus.enum.ts                         [NEW]
    │   ├── sessionKeyStatus.enum.ts                        [NEW]
    │   └── solverType.enum.ts                              [NEW]
    ├── time/dateTime.ts                                    [keep]
    └── uuid.ts                                             [keep]
```

---

## 3. Domain Types (Shared Contracts)

### 3.1 IntentPackage

The canonical output of the Intent Parser. All downstream components consume this.

```typescript
// src/use-cases/interface/output/intentParser.interface.ts
interface IntentPackage {
  action: "swap" | "stake" | "unstake" | "claim_rewards" | "transfer" | "unknown";
  tokenIn?: {
    symbol: string;
    address: string;    // resolved by Token Registry
    decimals: number;
    amountHuman: string; // "100.0"
    amountRaw: string;   // wei/units as string bigint
  };
  tokenOut?: {
    symbol: string;
    address: string;
    decimals: number;
  };
  slippageBps?: number;      // basis points, e.g. 50 = 0.5%
  recipient?: string;        // defaults to user's SCA address
  confidence: number;        // 0–1, LLM self-rated confidence
  rawInput: string;
}
```

### 3.2 SimulationReport

```typescript
// referenced in intent_executions.simulationResult
interface SimulationReport {
  passed: boolean;
  tokenInDelta: string;      // negative = user spends
  tokenOutDelta: string;     // positive = user receives
  gasEstimate: string;
  warnings: string[];
  rawLogs?: string[];
}
```

### 3.3 UserOperation

```typescript
// src/use-cases/interface/output/blockchain/userOperation.interface.ts
interface IUserOperation {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string;
  signature: string;
}

interface IUserOperationBuilder {
  build(params: {
    smartAccountAddress: string;
    callData: string;
    sessionKey: { privateKey: string; address: string };
    paymaster?: string;
  }): Promise<IUserOperation>;
  submit(userOp: IUserOperation): Promise<{ userOpHash: string }>;
  waitForReceipt(userOpHash: string): Promise<{ txHash: string; success: boolean }>;
}
```

---

## 4. Component Specifications

### 4.1 AnthropicOrchestrator

**File:** `src/adapters/implementations/output/orchestrator/anthropic.ts`

- Implement `IOrchestrator` (same interface as OpenAI version)
- Use `@anthropic-ai/sdk` — `new Anthropic({ apiKey })`
- Model: `claude-sonnet-4-6` (read from `ANTHROPIC_MODEL` env var, default `claude-sonnet-4-6`)
- Map `IOrchestratorMessage[]` → Anthropic `MessageParam[]`:
  - `ASSISTANT_TOOL_CALL` → `{ role: "assistant", content: [{ type: "tool_use", id, name, input }] }`
  - `TOOL` → `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`
  - `USER` → `{ role: "user", content: text }`
  - `ASSISTANT` → `{ role: "assistant", content: text }`
- Map `IToolDefinition[]` → Anthropic `Tool[]` (name, description, input_schema from `inputSchema`)
- Call `client.messages.create({ model, system, messages, tools, max_tokens: 4096 })`
- If `stop_reason === "tool_use"` → return `{ toolCalls: [...] }`; else return `{ text: content[0].text }`

### 4.2 IntentParser

**File:** `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts`

```typescript
interface IIntentParser {
  parse(input: string, userId: string): Promise<IntentPackage>;
}
```

Implementation:
- Calls Claude with a strict system prompt instructing JSON-only output
- System prompt includes the verified token list for the chain (fetched from `ITokenRegistryDB`)
- Uses `zod` to validate the returned JSON against the `IntentPackage` schema
- If validation fails or `action === "unknown"` → return with `confidence: 0`
- Does **not** call the full orchestrator — direct API call for determinism

### 4.3 TokenRegistry (DB adapter)

**File:** `src/adapters/implementations/output/tokenRegistry/db.tokenRegistry.ts`

```typescript
interface ITokenRegistryService {
  resolve(symbol: string, chainId: number): Promise<{ address: string; decimals: number } | undefined>;
  listByChain(chainId: number): Promise<TokenRecord[]>;
}
```

Implementation reads from the `token_registry` DB table. The table is seeded via a migration script (see §6).

### 4.4 PreFlight Simulator

**File:** `src/adapters/implementations/output/simulator/rpc.simulator.ts`

```typescript
interface ISimulator {
  simulate(params: {
    userOp: IUserOperation;
    intent: IntentPackage;
    chainId: number;
  }): Promise<SimulationReport>;
}
```

Implementation:
- Uses viem `publicClient.call()` to simulate the calldata
- Parses ERC-20 Transfer events from the simulated trace to derive `tokenInDelta` / `tokenOutDelta`
- Compares result to `intent`: if output token amount < expected × (1 - slippage), mark `passed: false`
- On simulation revert: set `passed: false`, include revert reason in `warnings`

### 4.5 SmartAccount Adapter

**File:** `src/adapters/implementations/output/blockchain/smartAccount.adapter.ts`

```typescript
interface ISmartAccountService {
  deploy(userId: string): Promise<{ smartAccountAddress: string; txHash: string }>;
  getAddress(userId: string): Promise<string>;
  isDeployed(address: string): Promise<boolean>;
}
```

Implementation:
- Uses `SessionKeyFactory` contract at `JARVIS_ACCOUNT_FACTORY_ADDRESS`
- Deterministic address derivation (CREATE2) before deployment
- Called once per user during registration

### 4.6 SessionKey Adapter

**File:** `src/adapters/implementations/output/blockchain/sessionKey.adapter.ts`

```typescript
interface ISessionKeyService {
  grant(params: {
    smartAccountAddress: string;
    scope: SessionKeyScope;
  }): Promise<{ sessionKeyAddress: string; txHash: string }>;
  revoke(smartAccountAddress: string, sessionKeyAddress: string): Promise<{ txHash: string }>;
  isValid(smartAccountAddress: string, sessionKeyAddress: string): Promise<boolean>;
}

interface SessionKeyScope {
  maxAmountPerTxUsd: number;    // e.g. 1000
  allowedTokenAddresses: string[];
  expiresAtEpoch: number;
}
```

Implementation:
- Interacts with `SessionKeyManager` at `SESSION_KEY_MANAGER_ADDRESS`
- The bot's master key is `BOT_PRIVATE_KEY` — used to sign the `grantSessionKey` transaction
- Stores resulting `sessionKeyAddress` + scope JSON to `user_profiles` table

### 4.7 UserOperation Builder

**File:** `src/adapters/implementations/output/blockchain/userOperation.builder.ts`

Implements `IUserOperationBuilder`:
- Uses viem to encode `callData` for `executeWithFee(target, value, data, feeBps, feeRecipient)`
- Fetches nonce from EntryPoint contract (`getNonce(sender, key)`)
- Estimates gas via `eth_estimateUserOperationGas` bundler RPC
- Signs UserOperation with session key (`BOT_PRIVATE_KEY`)
- Submits via `eth_sendUserOperation` bundler RPC
- Polls `eth_getUserOperationReceipt` until confirmed

### 4.8 SolverRegistry

**File:** `src/adapters/implementations/output/solver/solverRegistry.ts`

```typescript
interface ISolverRegistry {
  getSolver(action: IntentPackage["action"]): ISolver | undefined;
  register(action: string, solver: ISolver): void;
}

interface ISolver {
  name: string;
  buildCalldata(intent: IntentPackage, userAddress: string): Promise<{ to: string; data: string; value: string }>;
}
```

Implementation:
- Singleton map of `action → ISolver`
- Wired in DI container

### 4.9 Restful Solver (TraderJoe)

**File:** `src/adapters/implementations/output/solver/restful/traderJoe.solver.ts`

Implements `ISolver` for `action: "swap"`:
- Calls Trader Joe V2 API (or 1inch aggregator) with `tokenIn`, `tokenOut`, `amountIn`, `slippage`
- Returns `{ to: routerAddress, data: encodedCalldata, value: "0" }`
- Wraps AVAX if `tokenIn.isNative`

### 4.10 IntentUseCase

**File:** `src/use-cases/implementations/intent.usecase.ts`

```typescript
interface IIntentUseCase {
  parseAndExecute(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    rawInput: string;
  }): Promise<IntentExecutionResult>;

  confirmAndExecute(params: {
    intentId: string;
    userId: string;
  }): Promise<IntentExecutionResult>;

  getHistory(userId: string): Promise<Intent[]>;
}

interface IntentExecutionResult {
  intentId: string;
  status: INTENT_STATUSES;
  simulationReport?: SimulationReport;
  humanSummary: string;        // Pre-flight summary or final result
  requiresConfirmation: boolean;
  executionId?: string;
  txHash?: string;
}
```

**Execution flow inside `parseAndExecute()`:**
```
1. intentParser.parse(rawInput, userId)           → IntentPackage
2. tokenRegistry.resolve(symbols)                 → fill addresses + decimals
3. If confidence < 0.7 → reject with explanation
4. solverRegistry.getSolver(intent.action)        → ISolver
5. solver.buildCalldata(intent, userSCA)          → { to, data, value }
6. userOpBuilder.build({ smartAccount, callData }) → IUserOperation
7. simulator.simulate({ userOp, intent })          → SimulationReport
8. If !simulation.passed → save intent(SIMULATION_FAILED) → return summary
9. Save intent(AWAITING_CONFIRMATION) to DB
10. Build human summary → return { requiresConfirmation: true }

// After user confirms via /confirm command:
11. confirmAndExecute() called
12. userOpBuilder.submit(userOp)                  → { userOpHash }
13. userOpBuilder.waitForReceipt(userOpHash)      → { txHash, success }
14. Save execution record + fee record to DB
15. resultParser.parse(receipt, intent)           → human success string
16. Return { status: COMPLETED, txHash, humanSummary }
```

### 4.11 ResultParser

**File:** `src/adapters/implementations/output/resultParser/tx.resultParser.ts`

```typescript
interface IResultParser {
  parse(params: {
    txHash: string;
    intent: IntentPackage;
    chainId: number;
  }): Promise<string>;
}
```

- Fetches tx receipt via viem
- Decodes ERC-20 Transfer events
- Produces human string: `"Success! Swapped 100 USDC → 1.84 AVAX. Tx: 0xabc..."`

### 4.12 GetPortfolio Tool

**File:** `src/adapters/implementations/output/tools/getPortfolio.tool.ts`

Implements `ITool`:
- Input schema: `{}` (no params — always fetches for the current user)
- Reads `smartAccountAddress` from `user_profiles`
- Calls viem `publicClient.readContract()` for each token in `token_registry` for the current chainId
- Returns formatted balance table

### 4.13 ExecuteIntent Tool

**File:** `src/adapters/implementations/output/tools/executeIntent.tool.ts`

Implements `ITool`:
- Input schema: `{ rawInput: string }`
- Delegates to `IIntentUseCase.parseAndExecute()`
- Returns the `humanSummary` for the LLM to relay to the user
- The LLM calls this when the user's message resembles a trading intent
- Constructor args: `userId, conversationId, intentUseCase`

---

## 5. Telegram Handler Changes

**File:** `src/adapters/implementations/input/telegram/handler.ts`

Add command handlers:

| Command | Behavior |
|---------|----------|
| `/confirm` | Calls `intentUseCase.confirmAndExecute(pendingIntentId)` for the user's latest `AWAITING_CONFIRMATION` intent |
| `/cancel` | Sets pending intent status to `REJECTED` |
| `/portfolio` | Calls `getPortfolio.tool` directly and displays balances |
| `/wallet` | Shows user's SCA address and session key status from `user_profiles` |

**Pre-flight display format** (sent before `/confirm` is requested):
```
⚡ Pre-Flight Check

Action: Swap
You send: 100 USDC
You receive: ~1.84 AVAX (est.)
Slippage: 0.5%
Protocol fee: 1%

Simulation: ✅ PASSED

Type /confirm to execute or /cancel to abort.
```

---

## 6. HTTP API Changes

**File:** `src/adapters/implementations/input/http/httpServer.ts`

Add endpoints:

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `GET` | `/intent/:intentId` | JWT | Fetch intent + execution status |
| `GET` | `/portfolio` | JWT | Fetch on-chain balances for user's SCA |
| `GET` | `/tokens?chainId=43113` | None | List verified tokens |

---

## 7. DI Wiring Changes

**File:** `src/adapters/inject/assistant.di.ts`

Add the following singletons (lazy, constructed on first access):

```typescript
// Blockchain
private viemClient: ViemClientAdapter | null = null;
private smartAccountService: SmartAccountAdapter | null = null;
private sessionKeyService: SessionKeyAdapter | null = null;
private userOpBuilder: UserOperationBuilder | null = null;

// Solver
private solverRegistry: SolverRegistry | null = null;

// Intelligence
private intentParser: AnthropicIntentParser | null = null;
private tokenRegistryService: DbTokenRegistryService | null = null;
private simulator: RpcSimulator | null = null;
private resultParser: TxResultParser | null = null;

// Orchestrator
private anthropicOrchestrator: AnthropicOrchestrator | null = null;
```

`getUseCase()` changes:
- Swap `OpenAIOrchestrator` for `AnthropicOrchestrator`
- Add `ExecuteIntentTool` and `GetPortfolioTool` to registry factory
- Pass `intentUseCase` to handler

`getAuthUseCase()` changes:
- After user creation, call `smartAccountService.deploy(userId)` and persist result to `user_profiles`

`getIntentUseCase()`: new method that wires `IntentUseCaseImpl`.

---

## 8. Registration Flow (Phase 2 change)

When `POST /auth/register` is called:

```
1. Create user record (existing)
2. Deploy ERC-4337 SCA via SessionKeyFactory → smartAccountAddress
3. Grant session key to BOT_PRIVATE_KEY address with default scope:
   { maxAmountPerTxUsd: 1000, allowedTokens: [USDC, AVAX], expiresAtEpoch: now + 30d }
4. Create user_profiles row with smartAccountAddress + sessionKeyAddress + scope
5. Return { userId } (existing response unchanged)
```

---

## 9. Token Registry Seed Data

Create a migration script `drizzle/seed/tokenRegistry.ts` that inserts verified tokens for Avalanche Fuji (chainId 43113):

| Symbol | Address | Decimals | isNative |
|--------|---------|----------|----------|
| AVAX | `0x0000000000000000000000000000000000000000` | 18 | true |
| WAVAX | `0xd00ae08403B9bbb9124bB305C09058E32C39A48c` | 18 | false |
| USDC | `0x5425890298aed601595a70AB815c96711a31Bc65` | 6 | false |

Run with: `npx ts-node drizzle/seed/tokenRegistry.ts`

---

## 10. Environment Variables

Add to `.env` / `.env.example`:

```env
# Anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6

# Avalanche
AVAX_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
AVAX_BUNDLER_URL=                         # ERC-4337 bundler endpoint (e.g. Pimlico)
BOT_PRIVATE_KEY=                          # Bot's master session key signer
ENTRY_POINT_ADDRESS=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
JARVIS_ACCOUNT_FACTORY_ADDRESS=0x160E43075D9912FFd7006f7Ad14f4781C7f0D443
SESSION_KEY_MANAGER_ADDRESS=0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291
TREASURY_ADDRESS=                         # Platform fee recipient wallet

# Solver
TRADERJOE_API_URL=https://api.traderjoexyz.com
ONEINCH_API_KEY=                          # Optional, if using 1inch aggregator

# Chain
CHAIN_ID=43113                            # 43113 = Fuji testnet
```

Remove: `OPENAI_API_KEY`, `OPENAI_MODEL` (after orchestrator swap is complete).

---

## 11. New NPM Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "viem": "^2.21.0"
  }
}
```

Install: `npm install @anthropic-ai/sdk viem`

---

## 12. Execution Order

Implement in this order — each step unblocks the next.

### Step 1 — New database + schema extension (blocker for everything)
1. Create PostgreSQL database `aether_intent`
2. Update `DATABASE_URL` default in `assistant.di.ts`
3. Add all new tables to `schema.ts` (§1.1)
4. Add new enum files (§1.2)
5. `npm run db:generate && npm run db:migrate`
6. Run token registry seed script

### Step 2 — New repository interfaces + Drizzle implementations
For each new table: write domain interface in `src/use-cases/interface/output/repository/`, write Drizzle implementation in `src/adapters/implementations/output/sqlDB/repositories/`, add as property to `DrizzleSqlDB`.

Order: `userProfile` → `tokenRegistry` → `intent` → `intentExecution` → `toolManifest` → `feeRecord`

### Step 3 — AnthropicOrchestrator
1. Implement `src/adapters/implementations/output/orchestrator/anthropic.ts`
2. Swap into `assistant.di.ts`
3. Verify existing chat flow still works end-to-end

### Step 4 — Blockchain adapters (can be done in parallel once viem client exists)
1. `viemClient.ts` — shared public + wallet clients
2. `smartAccount.adapter.ts`
3. `sessionKey.adapter.ts`
4. `userOperation.builder.ts`
5. `paymaster.adapter.ts`

### Step 5 — Registration flow update
Update `auth.usecase.ts` to deploy SCA + grant session key on register. Test with a fresh user.

### Step 6 — Token Registry service
Implement `db.tokenRegistry.ts`. Wire into DI.

### Step 7 — IntentParser
Implement `anthropic.intentParser.ts`. Unit test with sample inputs.

### Step 8 — Solver Engine
1. `solverRegistry.ts`
2. `claimRewards.solver.ts` (static — simplest)
3. `traderJoe.solver.ts` (restful — for swaps)

### Step 9 — PreFlight Simulator
Implement `rpc.simulator.ts`. Test with a known-good swap calldata.

### Step 10 — IntentUseCase + ResultParser
1. `intent.usecase.ts` — full parse → simulate → confirm → execute flow
2. `tx.resultParser.ts`

### Step 11 — New tools + updated tool registry
1. `executeIntent.tool.ts`
2. `getPortfolio.tool.ts`
3. Register both in `registryFactory` in `assistant.di.ts`

### Step 12 — Telegram handler + HTTP API
1. Add `/confirm`, `/cancel`, `/portfolio`, `/wallet` commands
2. Add HTTP endpoints

### Step 13 — Integration test (end-to-end)
1. Register new user → verify SCA deployed + row in `user_profiles`
2. Send "Buy $10 of AVAX" → verify intent parsed, simulation runs, pre-flight message sent
3. Send `/confirm` → verify UserOperation submitted, fee record written, success message returned
4. Send `/portfolio` → verify balances returned from SCA

---

## 13. Critical Files Summary

| File | Action | Step |
|------|--------|------|
| `src/adapters/implementations/output/sqlDB/schema.ts` | Add 5 new tables, extend userProfiles | 1 |
| `src/helpers/enums/intentStatus.enum.ts` | New | 1 |
| `src/helpers/enums/executionStatus.enum.ts` | New | 1 |
| `src/helpers/enums/sessionKeyStatus.enum.ts` | New | 1 |
| `src/helpers/enums/solverType.enum.ts` | New | 1 |
| `src/adapters/implementations/output/sqlDB/repositories/userProfile.repo.ts` | New | 2 |
| `src/adapters/implementations/output/sqlDB/repositories/tokenRegistry.repo.ts` | New | 2 |
| `src/adapters/implementations/output/sqlDB/repositories/intent.repo.ts` | New | 2 |
| `src/adapters/implementations/output/sqlDB/repositories/intentExecution.repo.ts` | New | 2 |
| `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` | New | 2 |
| `src/adapters/implementations/output/sqlDB/repositories/feeRecord.repo.ts` | New | 2 |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | Add new repo properties | 2 |
| `src/adapters/implementations/output/orchestrator/anthropic.ts` | New | 3 |
| `src/adapters/inject/assistant.di.ts` | Swap orchestrator, wire all new deps | 3+ |
| `src/adapters/implementations/output/blockchain/viemClient.ts` | New | 4 |
| `src/adapters/implementations/output/blockchain/smartAccount.adapter.ts` | New | 4 |
| `src/adapters/implementations/output/blockchain/sessionKey.adapter.ts` | New | 4 |
| `src/adapters/implementations/output/blockchain/userOperation.builder.ts` | New | 4 |
| `src/use-cases/implementations/auth.usecase.ts` | Deploy SCA on register | 5 |
| `src/adapters/implementations/output/tokenRegistry/db.tokenRegistry.ts` | New | 6 |
| `src/adapters/implementations/output/intentParser/anthropic.intentParser.ts` | New | 7 |
| `src/adapters/implementations/output/solver/solverRegistry.ts` | New | 8 |
| `src/adapters/implementations/output/solver/restful/traderJoe.solver.ts` | New | 8 |
| `src/adapters/implementations/output/simulator/rpc.simulator.ts` | New | 9 |
| `src/use-cases/implementations/intent.usecase.ts` | New | 10 |
| `src/adapters/implementations/output/resultParser/tx.resultParser.ts` | New | 10 |
| `src/adapters/implementations/output/tools/executeIntent.tool.ts` | New | 11 |
| `src/adapters/implementations/output/tools/getPortfolio.tool.ts` | New | 11 |
| `src/adapters/implementations/input/telegram/handler.ts` | Add commands | 12 |
| `src/adapters/implementations/input/http/httpServer.ts` | Add endpoints | 12 |
| `drizzle/seed/tokenRegistry.ts` | New seed script | 1 |
