# System Tools — Backend Implementation Plan

> Date: 2026-04-21
> Status: Draft
> Touches: `assistant.di.ts`, new files only (no existing tool files modified)

---

## Goal

Introduce a set of **system tools** that are available to every user by default — no DB registration, no developer setup required. The agent can call these tools out of the box.

**System tool list:**
1. `transfer_erc20` — wraps the existing `ExecuteIntentTool` with a focused ERC20 schema
2. `privy_wallet_balances` — aggregated native + stable balances across chains for the current user
3. `privy_transaction_status` — lifecycle status of a Privy-managed transaction
4. `privy_gas_spend` — Paymaster/gas sponsorship spend for the app
5. `privy_rpc_proxy` — arbitrary JSON-RPC read via Privy (eth_call, eth_estimateGas, etc.)

**Design constraints:**
- Hexagonal architecture: new port `IWalletDataProvider` in the use-cases layer; Privy REST adapter in the adapters layer — swap Privy out later by replacing only the adapter
- `transfer_erc20` delegates `execute()` to `ExecuteIntentTool` — zero logic duplication
- Privy credentials come from `PRIVY_APP_ID` / `PRIVY_APP_SECRET` in `.env` — never hardcoded
- User wallet identity is resolved automatically from the Redis profile cache (`privyDid`) so the LLM never has to supply a `wallet_id`
- Existing `ExecuteIntentTool`, `WebSearchTool`, `GetPortfolioTool`, and all HTTP query tools are **unmodified**

---

## Architecture Diagram

```
registryFactory(userId, conversationId)
  │
  ├── WebSearchTool                     (existing)
  ├── ExecuteIntentTool                 (existing)
  ├── GetPortfolioTool                  (existing)
  │
  ├── systemToolProvider.getTools(userId, conversationId)   ← NEW
  │     ├── TransferErc20Tool           wraps ExecuteIntentTool.execute()
  │     ├── WalletBalancesTool          uses IWalletDataProvider
  │     ├── TransactionStatusTool       uses IWalletDataProvider
  │     ├── GasSpendTool                uses IWalletDataProvider
  │     └── RpcProxyTool                uses IWalletDataProvider
  │
  └── HttpQueryTool[]                   (existing, from DB per userId)


IWalletDataProvider  (port — use-cases layer)
       │
       └── PrivyWalletDataProvider      (adapter — adapters layer)
             │  reads: PRIVY_APP_ID, PRIVY_APP_SECRET from env
             │  resolves: privyDid → Privy wallet_id via GET /v1/users/{privyDid}
             └── fetch() to api.privy.io


User identity flow inside Privy tools:
  tool.execute(input)
    → userProfileCache.get(userId)  → PrivyUserProfile.privyDid
    → walletDataProvider.getBalances(privyDid)
    → PrivyWalletDataProvider.resolveWalletId(privyDid)  [private, one API call]
    → fetch("https://api.privy.io/v1/wallets/{wallet_id}/balance")
```

---

## File Map

| File | Change |
|---|---|
| `src/use-cases/interface/output/walletDataProvider.interface.ts` | **NEW** port `IWalletDataProvider` + return-type DTOs |
| `src/use-cases/interface/output/systemToolProvider.interface.ts` | **NEW** port `ISystemToolProvider` |
| `src/use-cases/implementations/systemToolProvider.usecase.ts` | **NEW** `SystemToolProviderImpl` assembles all 5 tools |
| `src/adapters/implementations/output/walletData/privy.walletDataProvider.ts` | **NEW** Privy REST implementation of `IWalletDataProvider` |
| `src/adapters/implementations/output/tools/system/transferErc20.tool.ts` | **NEW** wraps `ExecuteIntentTool` |
| `src/adapters/implementations/output/tools/system/walletBalances.tool.ts` | **NEW** |
| `src/adapters/implementations/output/tools/system/transactionStatus.tool.ts` | **NEW** |
| `src/adapters/implementations/output/tools/system/gasSpend.tool.ts` | **NEW** |
| `src/adapters/implementations/output/tools/system/rpcProxy.tool.ts` | **NEW** |
| `src/adapters/inject/assistant.di.ts` | **Modified** wire provider + add to `registryFactory` |

---

## Step 1 — Port: `IWalletDataProvider`

**File:** `src/use-cases/interface/output/walletDataProvider.interface.ts`

The port is defined in terms of generic domain concepts — no Privy-specific types leak in.
`userIdentifier` is whatever opaque string the concrete provider uses to look up a user's wallet
(for Privy this is `privyDid`; a future provider might use an internal user ID or DID).

```typescript
export interface WalletBalance {
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string | null; // null for native token
  decimals: number;
  rawAmount: string;          // wei / smallest unit, as string
  usdDisplay: string;         // human-readable USD string e.g. "$12.34"
}

export interface WalletTransactionStatus {
  id: string;
  status: "broadcasted" | "confirmed" | "failed" | "unknown";
  transactionHash?: string;
  chainId?: number;
}

export interface GasSpendResult {
  totalUsd: number;
  currency: string;            // "USD"
}

export interface IWalletDataProvider {
  /** Fetch all balances for the wallet identified by userIdentifier */
  getBalances(userIdentifier: string): Promise<WalletBalance[]>;

  /** Fetch the lifecycle status of a specific transaction */
  getTransactionStatus(transactionId: string): Promise<WalletTransactionStatus | null>;

  /** Fetch aggregate gas sponsorship spend. userIdentifiers filters by wallet (optional) */
  getGasSpend(userIdentifiers?: string[], startDate?: string): Promise<GasSpendResult>;

  /**
   * Proxy a JSON-RPC call through the wallet provider.
   * network: a canonical chain string, e.g. "avalanche", "ethereum", "base"
   * The implementation maps this to its own chain ID format (e.g. CAIP-2 for Privy).
   */
  rpcCall(
    userIdentifier: string,
    method: string,
    network: string,
    params: unknown[],
  ): Promise<unknown>;
}
```

---

## Step 2 — Port: `ISystemToolProvider`

**File:** `src/use-cases/interface/output/systemToolProvider.interface.ts`

```typescript
import type { ITool } from "./tool.interface";

export interface ISystemToolProvider {
  /**
   * Returns all system tools instantiated for the given user+conversation.
   * Called once per registryFactory invocation.
   */
  getTools(userId: string, conversationId: string): ITool[];
}
```

---

## Step 3 — Use-case implementation: `SystemToolProviderImpl`

**File:** `src/use-cases/implementations/systemToolProvider.usecase.ts`

This class owns the assembly of all system tools. It holds shared dependencies (intent use-case,
wallet data provider, profile cache) and produces fresh tool instances per call.

```typescript
import type { ITool } from "../interface/output/tool.interface";
import type { ISystemToolProvider } from "../interface/output/systemToolProvider.interface";
import type { IWalletDataProvider } from "../interface/output/walletDataProvider.interface";
import type { IIntentUseCase } from "../interface/input/intent.interface";
import type { IUserProfileCache } from "../interface/output/cache/userProfile.cache";
import { TransferErc20Tool } from "../../adapters/implementations/output/tools/system/transferErc20.tool";
import { WalletBalancesTool } from "../../adapters/implementations/output/tools/system/walletBalances.tool";
import { TransactionStatusTool } from "../../adapters/implementations/output/tools/system/transactionStatus.tool";
import { GasSpendTool } from "../../adapters/implementations/output/tools/system/gasSpend.tool";
import { RpcProxyTool } from "../../adapters/implementations/output/tools/system/rpcProxy.tool";

export class SystemToolProviderImpl implements ISystemToolProvider {
  constructor(
    private readonly intentUseCase: IIntentUseCase,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  getTools(userId: string, conversationId: string): ITool[] {
    return [
      new TransferErc20Tool(userId, conversationId, this.intentUseCase),
      new WalletBalancesTool(userId, this.walletDataProvider, this.userProfileCache),
      new TransactionStatusTool(this.walletDataProvider),
      new GasSpendTool(userId, this.walletDataProvider, this.userProfileCache),
      new RpcProxyTool(userId, this.walletDataProvider, this.userProfileCache),
    ];
  }
}
```

**Note:** The import paths cross the hexagonal boundary (use-case imports adapters). This is the one place
where the boundary is intentionally crossed — it is the assembly point, exactly like how `ExecuteIntentTool`
is instantiated inside `registryFactory` in `assistant.di.ts`. If stricter separation is needed later,
move the assembly into `assistant.di.ts` and make `SystemToolProviderImpl` accept an `ITool[]` factory
instead. For now, follow the existing pattern.

---

## Step 4 — Adapter: `PrivyWalletDataProvider`

**File:** `src/adapters/implementations/output/walletData/privy.walletDataProvider.ts`

Key design points:
- Constructor takes `appId` and `appSecret` (injected from env in DI, not read from env directly here)
- Private `resolveWalletId(privyDid)` fetches `GET /v1/users/{privyDid}` and returns the embedded
  wallet's entity `id`. This is NOT the on-chain address — it's Privy's internal wallet entity ID.
- All network calls use `fetch()` from Node 18+ built-in
- Privy `caip2` format: `"eip155:{chainId}"` — the `network` parameter from the port is mapped using
  a static lookup table

```typescript
import type {
  IWalletDataProvider,
  WalletBalance,
  WalletTransactionStatus,
  GasSpendResult,
} from "../../../../use-cases/interface/output/walletDataProvider.interface";

const NETWORK_TO_CAIP2: Record<string, string> = {
  avalanche:         "eip155:43114",
  "avalanche-fuji":  "eip155:43113",
  ethereum:          "eip155:1",
  base:              "eip155:8453",
  polygon:           "eip155:137",
  arbitrum:          "eip155:42161",
  optimism:          "eip155:10",
};

export class PrivyWalletDataProvider implements IWalletDataProvider {
  private readonly baseUrl = "https://api.privy.io";
  private readonly authHeader: string;

  constructor(private readonly appId: string, appSecret: string) {
    this.authHeader = "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64");
  }

  private async privyFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "privy-app-id": this.appId,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Privy API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Resolve privyDid → embedded wallet entity ID (Privy-internal, not on-chain address) */
  private async resolveWalletId(privyDid: string): Promise<string> {
    const user = await this.privyFetch<{
      linked_accounts: Array<{ id: string; type: string; wallet_client_type?: string }>;
    }>(`/v1/users/${encodeURIComponent(privyDid)}`);

    const embedded = user.linked_accounts.find(
      (a) => a.type === "wallet" && a.wallet_client_type === "privy",
    );
    if (!embedded) throw new Error("PRIVY_NO_EMBEDDED_WALLET");
    return embedded.id;
  }

  async getBalances(privyDid: string): Promise<WalletBalance[]> {
    const walletId = await this.resolveWalletId(privyDid);
    const data = await this.privyFetch<{ data: Array<{
      chain_id: number;
      token_symbol: string;
      token_address: string | null;
      decimals: number;
      balance: string;
      balance_usd: string;
    }> }>(`/v1/wallets/${encodeURIComponent(walletId)}/balance`);

    return (data.data ?? []).map((b) => ({
      chainId: b.chain_id,
      tokenSymbol: b.token_symbol,
      tokenAddress: b.token_address,
      decimals: b.decimals,
      rawAmount: b.balance,
      usdDisplay: b.balance_usd,
    }));
  }

  async getTransactionStatus(transactionId: string): Promise<WalletTransactionStatus | null> {
    try {
      const data = await this.privyFetch<{
        id: string;
        status: string;
        transaction_hash?: string;
        chain_id?: number;
      }>(`/v1/transactions/${encodeURIComponent(transactionId)}`);

      const status = (["broadcasted", "confirmed", "failed"] as const).find(
        (s) => s === data.status,
      ) ?? "unknown";

      return {
        id: data.id,
        status,
        transactionHash: data.transaction_hash,
        chainId: data.chain_id,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Privy API 404")) return null;
      throw err;
    }
  }

  async getGasSpend(privyDids?: string[], startDate?: string): Promise<GasSpendResult> {
    const params = new URLSearchParams();
    if (privyDids?.length) {
      // Privy accepts wallet_ids[] — resolve DIDs to wallet IDs if needed.
      // For now pass privyDids directly; the Privy gas_spend endpoint accepts user DID filters
      // under the query param wallet_ids[]=<id>. Adjust if Privy requires wallet entity IDs.
      privyDids.forEach((did) => params.append("wallet_ids[]", did));
    }
    if (startDate) params.set("start_date", startDate);

    const qs = params.toString();
    const data = await this.privyFetch<{ total_charged_usd: number }>(
      `/v1/apps/gas_spend${qs ? `?${qs}` : ""}`,
    );

    return { totalUsd: data.total_charged_usd ?? 0, currency: "USD" };
  }

  async rpcCall(
    privyDid: string,
    method: string,
    network: string,
    params: unknown[],
  ): Promise<unknown> {
    const walletId = await this.resolveWalletId(privyDid);
    const caip2 = NETWORK_TO_CAIP2[network.toLowerCase()] ?? network; // pass-through if already caip2

    const data = await this.privyFetch<{ result: unknown }>(
      `/v1/wallets/${encodeURIComponent(walletId)}/rpc`,
      {
        method: "POST",
        body: JSON.stringify({ method, caip2, chain_type: "ethereum", params }),
      },
    );

    return data.result;
  }
}
```

---

## Step 5 — System Tool: `TransferErc20Tool`

**File:** `src/adapters/implementations/output/tools/system/transferErc20.tool.ts`

Wraps `ExecuteIntentTool`. Has its own tool name (`transfer_erc20`) and a concrete ERC20-focused schema.
The `execute()` delegates to the inner tool unchanged — no solver/intent logic is duplicated.

```typescript
import { z } from "zod";
import { TOOL_TYPE } from "../../../../../helpers/enums/toolType.enum";
import { ExecuteIntentTool } from "../executeIntent.tool";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IIntentUseCase } from "../../../../../use-cases/interface/input/intent.interface";

const InputSchema = z.object({
  recipient: z.string().describe("Recipient wallet address (0x…)"),
  tokenAddress: z.string().describe("ERC-20 token contract address (0x…)"),
  amount: z.string().describe("Human-readable amount to transfer, e.g. '10.5'"),
  network: z.string().optional().describe("Target network name, e.g. 'avalanche', 'base'. Defaults to the configured chain."),
});

export class TransferErc20Tool implements ITool {
  private readonly delegate: ExecuteIntentTool;

  constructor(userId: string, conversationId: string, intentUseCase: IIntentUseCase) {
    this.delegate = new ExecuteIntentTool(userId, conversationId, intentUseCase);
  }

  definition(): IToolDefinition {
    return {
      name: "transfer_erc20",
      description:
        "Transfer an ERC-20 token from the user's wallet to a recipient address. " +
        "Provide the exact token contract address, recipient, and amount. " +
        "Use this for token sends — not for swaps or staking.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    // Build a natural-language intent string and delegate to ExecuteIntentTool
    const parsed = InputSchema.safeParse(input);
    const rawInput = parsed.success
      ? `Transfer ${parsed.data.amount} of token ${parsed.data.tokenAddress} to ${parsed.data.recipient}${parsed.data.network ? ` on ${parsed.data.network}` : ""}`
      : JSON.stringify(input); // fallback: let intent parser figure it out

    return this.delegate.execute({ rawInput });
  }
}
```

**Why build `rawInput` instead of passing `input` directly:**
`ExecuteIntentTool.execute()` expects `{ rawInput: string }`. The ERC20 tool's schema is structured
(address, amount, etc.), so we synthesize a clear natural-language sentence for the intent parser
to consume. This keeps the intent parser's existing NLP flow intact.

---

## Step 6 — System Tool: `WalletBalancesTool`

**File:** `src/adapters/implementations/output/tools/system/walletBalances.tool.ts`

No required LLM input — the user's wallet is resolved automatically from the profile cache.

```typescript
import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../../../use-cases/interface/output/cache/userProfile.cache";

const InputSchema = z.object({}).optional();

export class WalletBalancesTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  definition(): IToolDefinition {
    return {
      name: "privy_wallet_balances",
      description:
        "Fetch the current wallet balances (native tokens and major stablecoins) across all chains " +
        "for the authenticated user. No input required.",
      inputSchema: z.toJSONSchema(z.object({})),
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    try {
      const profile = await this.userProfileCache?.get(this.userId).catch(() => null);
      if (!profile?.privyDid) {
        return { success: false, error: "USER_PROFILE_NOT_FOUND: cannot resolve wallet identity" };
      }
      const balances = await this.walletDataProvider.getBalances(profile.privyDid);
      return { success: true, data: balances };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
```

---

## Step 7 — System Tool: `TransactionStatusTool`

**File:** `src/adapters/implementations/output/tools/system/transactionStatus.tool.ts`

```typescript
import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";

const InputSchema = z.object({
  transaction_id: z.string().describe("The Privy transaction ID to look up"),
});

export class TransactionStatusTool implements ITool {
  constructor(private readonly walletDataProvider: IWalletDataProvider) {}

  definition(): IToolDefinition {
    return {
      name: "privy_transaction_status",
      description:
        "Check the status of a transaction managed by Privy. Returns whether the transaction " +
        "has been broadcasted, confirmed, or failed, along with the on-chain hash.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { transaction_id } = InputSchema.parse(input);
      const status = await this.walletDataProvider.getTransactionStatus(transaction_id);
      if (!status) return { success: false, error: "TRANSACTION_NOT_FOUND" };
      return { success: true, data: status };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
```

---

## Step 8 — System Tool: `GasSpendTool`

**File:** `src/adapters/implementations/output/tools/system/gasSpend.tool.ts`

Auto-scopes to the current user's wallet — no manual wallet ID input needed.

```typescript
import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../../../use-cases/interface/output/cache/userProfile.cache";

const InputSchema = z.object({
  start_date: z.string().optional().describe("Optional ISO date string for the start of the query window"),
});

export class GasSpendTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  definition(): IToolDefinition {
    return {
      name: "privy_gas_spend",
      description:
        "Get the total gas sponsorship (Paymaster) spend charged for the current user's smart account. " +
        "Returns the aggregate USD value of credits consumed. Optionally filter by start date.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { start_date } = InputSchema.parse(input);
      const profile = await this.userProfileCache?.get(this.userId).catch(() => null);
      const userIds = profile?.privyDid ? [profile.privyDid] : undefined;
      const result = await this.walletDataProvider.getGasSpend(userIds, start_date);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
```

---

## Step 9 — System Tool: `RpcProxyTool`

**File:** `src/adapters/implementations/output/tools/system/rpcProxy.tool.ts`

```typescript
import { z } from "zod";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../../use-cases/interface/output/tool.interface";
import type { IWalletDataProvider } from "../../../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../../../use-cases/interface/output/cache/userProfile.cache";

const InputSchema = z.object({
  method: z.string().describe(
    "JSON-RPC method name, e.g. eth_call, eth_estimateGas, eth_getTransactionCount",
  ),
  network: z.string().describe(
    "Target network: 'avalanche', 'avalanche-fuji', 'ethereum', 'base', 'polygon', 'arbitrum', 'optimism'. " +
    "Or pass a raw CAIP-2 string such as 'eip155:43114'.",
  ),
  params: z.array(z.unknown()).describe("JSON-RPC params array appropriate to the method"),
});

export class RpcProxyTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  definition(): IToolDefinition {
    return {
      name: "privy_rpc_proxy",
      description:
        "Proxy a read-only JSON-RPC call (eth_call, eth_estimateGas, eth_getTransactionCount, " +
        "or custom contract reads) through the wallet provider for the current user. " +
        "Use this for on-chain data reads that require the user's wallet context.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { method, network, params } = InputSchema.parse(input);
      const profile = await this.userProfileCache?.get(this.userId).catch(() => null);
      if (!profile?.privyDid) {
        return { success: false, error: "USER_PROFILE_NOT_FOUND: cannot resolve wallet identity" };
      }
      const result = await this.walletDataProvider.rpcCall(profile.privyDid, method, network, params);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
```

---

## Step 10 — DI wiring in `assistant.di.ts`

**File:** `src/adapters/inject/assistant.di.ts`

### 10a — New imports

```typescript
import { PrivyWalletDataProvider } from "../implementations/output/walletData/privy.walletDataProvider";
import { SystemToolProviderImpl } from "../../use-cases/implementations/systemToolProvider.usecase";
import type { IWalletDataProvider } from "../../use-cases/interface/output/walletDataProvider.interface";
import type { ISystemToolProvider } from "../../use-cases/interface/output/systemToolProvider.interface";
```

### 10b — New private fields

```typescript
private _walletDataProvider: IWalletDataProvider | null = null;
private _systemToolProvider: ISystemToolProvider | null = null;
```

### 10c — New getters

```typescript
getWalletDataProvider(): IWalletDataProvider {
  if (!this._walletDataProvider) {
    this._walletDataProvider = new PrivyWalletDataProvider(
      process.env.PRIVY_APP_ID ?? "",
      process.env.PRIVY_APP_SECRET ?? "",
    );
  }
  return this._walletDataProvider;
}

getSystemToolProvider(): ISystemToolProvider {
  if (!this._systemToolProvider) {
    this._systemToolProvider = new SystemToolProviderImpl(
      this.getIntentUseCase(),
      this.getWalletDataProvider(),
      this.getUserProfileCache(),
    );
  }
  return this._systemToolProvider;
}
```

### 10d — Update `registryFactory` inside `getUseCase()`

Add system tools after the three existing tools, before the DB http tools:

```typescript
const registryFactory = async (userId: string, conversationId: string): Promise<IToolRegistry> => {
  const r = new ToolRegistryConcrete();

  // Existing static tools
  r.register(new WebSearchTool(webSearchService));
  r.register(new ExecuteIntentTool(userId, conversationId, intentUseCase));
  r.register(new GetPortfolioTool(userId, userProfileDB, tokenRegistryService, viemClient, chainId));

  // System tools — always available, no DB registration needed
  for (const tool of this.getSystemToolProvider().getTools(userId, conversationId)) {
    r.register(tool);
  }

  // Per-user DB tools (developer-registered HTTP query tools)
  const httpToolDB = this.getSqlDB().httpQueryTools;
  const userHttpTools = await httpToolDB.findActiveByUser(userId);
  const userProfileCache = this.getUserProfileCache();
  const encryptionKey = process.env.HTTP_TOOL_HEADER_ENCRYPTION_KEY;

  for (const toolConfig of userHttpTools) {
    const headers = await httpToolDB.getHeaders(toolConfig.id);
    r.register(
      new HttpQueryTool(toolConfig, headers, userId, userProfileCache, userProfileDB, orchestrator, encryptionKey),
    );
  }

  return r;
};
```

---

## Guardrails

### No vendor lock-in leakage
- `IWalletDataProvider` uses `userIdentifier: string` — not `privyDid`. The Privy adapter
  happens to treat it as a DID, but nothing in the port or use-case layer references Privy.
- `NETWORK_TO_CAIP2` lives entirely inside `PrivyWalletDataProvider` — the port uses plain strings.
- Swapping to a different wallet provider = one new file in `adapters/implementations/output/walletData/`
  and one line change in `assistant.di.ts`.

### Name collision with DB-registered tools
The system tools use the same names as the DB tools we inserted for testing:
`privy_wallet_balances`, `privy_transaction_status`, `privy_gas_spend`, `privy_rpc_proxy`.

Since system tools are registered **before** DB tools in `registryFactory`, if the user has a
DB-registered tool with the same name, the DB tool will overwrite the system tool in the registry
(last `Map.set` wins). This is acceptable — a developer can override a system tool by registering
one with the same name. If you want system tools to be unoverridable, register them **after** DB
tools, or add a check in `ToolRegistryConcrete.register()` that skips overwriting reserved names.

**Recommended follow-up:** delete the 4 test DB entries for `JARVIS_USER_ID` once the system tools
are live, so there is no double-registration:
```sql
DELETE FROM http_query_tools WHERE user_id = 'df32c1e6-499d-4710-a922-868ef02d2fd0';
```

### Privy credential check
`PrivyWalletDataProvider` is always instantiated (even if `PRIVY_APP_ID` is unset) because the
`PrivyClient` is lazy — it only makes network calls at `execute()` time. If the credentials are
missing, the tool will return `{ success: false, error: "Privy API 401: ..." }` at runtime rather
than crashing at startup.

### `userProfileCache` optional guard
All 4 Privy tools accept `IUserProfileCache | undefined`. If Redis is unavailable, the tools
that need `privyDid` return `USER_PROFILE_NOT_FOUND`. `TransactionStatusTool` is unaffected —
it takes a `transaction_id` directly with no user resolution needed.

---

## Implementation Order

1. `src/use-cases/interface/output/walletDataProvider.interface.ts`
2. `src/use-cases/interface/output/systemToolProvider.interface.ts`
3. `src/adapters/implementations/output/walletData/privy.walletDataProvider.ts`
4. `src/adapters/implementations/output/tools/system/transferErc20.tool.ts`
5. `src/adapters/implementations/output/tools/system/walletBalances.tool.ts`
6. `src/adapters/implementations/output/tools/system/transactionStatus.tool.ts`
7. `src/adapters/implementations/output/tools/system/gasSpend.tool.ts`
8. `src/adapters/implementations/output/tools/system/rpcProxy.tool.ts`
9. `src/use-cases/implementations/systemToolProvider.usecase.ts`
10. `src/adapters/inject/assistant.di.ts` (add getters + update registryFactory)
11. `npx tsc --noEmit` — must be clean
