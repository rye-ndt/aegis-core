# Blockchain Port & Avalanche Adapter — Implementation Plan

> Last updated: 2026-04-09
> Scope: Define `IBlockchainService` port interface + `AvalancheBlockchainService` concrete adapter.
> Libraries: `viem`, `permissionless` (installed but not used in current flow — reserved for future AA features).
> Network: Avalanche Fuji Testnet (Chain ID: 43113)

---

## What already exists — do not recreate

These are already fully implemented and must not be touched:

| File | Status |
|---|---|
| `schema.ts` — `user_profiles.smart_account_address`, `user_profiles.eoa_address` | ✅ columns exist |
| `schema.ts` — `evaluation_logs.contributed_at_epoch / contribution_tx_hash / contribution_data_hash` | ✅ columns exist |
| `IUserProfileDB.updateSmartAccount(userId, smartAccountAddress, eoaAddress)` | ✅ interface + impl exist |
| `IEvaluationLogDB.markContributed(id, txHash, dataHash, epoch)` | ✅ interface + impl exist |
| `IEvaluationLogDB.findContributable(userId)` | ✅ interface + impl exist |
| `IUserProfile.smartAccountAddress / eoaAddress` | ✅ already on type |

---

## Contract reference (Avalanche Fuji)

| Contract | Proxy Address |
|---|---|
| AegisToken | `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69` |
| RewardController | `0x519092C2185E4209B43d3ea40cC34D39978073A7` |
| JarvisAccountFactory | TBD — read from `JARVIS_ACCOUNT_FACTORY_ADDRESS` env var |
| ERC-4337 EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |

Bot wallet: `0xc018E6218e4dfF7a94A8Fd4C8b6CE9A99B0ec078` — holds `CLAIMER_ROLE` on RewardController.

### Key contract function signatures

```solidity
// JarvisAccountFactory
createAccount(address owner, bytes32 salt) external returns (address)
getAddress(address owner, bytes32 salt) external view returns (address)

// RewardController
claimReward(address user, bytes32 dataHash) external  // requires CLAIMER_ROLE
event DataContributed(address indexed user, bytes32 indexed dataHash, uint256 amount)

// AegisToken (ERC-20)
balanceOf(address account) external view returns (uint256)
```

> ⚠️ The factory signatures above (`owner, salt`) follow the ERC-4337 standard.
> **Verify these against the actual deployed contract before writing code.**
> If the deployed factory only takes `createAccount(address owner)` without salt,
> then every call would overwrite the same account. In that case the factory likely
> reverts if already deployed — the idempotency check (`getCode`) still applies.

---

## Execution order

Each step is a prerequisite for the next that depends on it. Steps 1–3 are prerequisites for everything.
Steps 4 and 5 are independent of each other once steps 1–3 are done.
Step 6 requires step 4. Step 7 requires step 5. Step 8 requires all prior steps.

```
Step 1: Install dependencies
Step 2: Port interface
Step 3: ABI files (4 files)
Step 4: AvalancheBlockchainService adapter
Step 5: IEvaluationLogDB.findByContributionDataHash (new method)
Step 6: ContributeDataTool
Step 7: Event listener wiring (telegramCli.ts)
Step 8: Auth use case wiring
Step 9: Assistant use case wiring (/contribute method)
Step 10: Telegram handler /contribute command
Step 11: DI wiring (assistant.di.ts)
Step 12: .env.example
```

---

## Step 1 — Install dependencies

Run:
```bash
npm install viem permissionless
npm install --save-dev @types/node
```

`permissionless` is installed now so the import path exists when needed for future ERC-4337 features. It is **not used** in any code in this plan — do not import it in the adapter yet.

---

## Step 2 — Port interface

**New file:** `src/use-cases/interface/output/blockchain.interface.ts`

```typescript
export interface IUserOnChainAccount {
  accountAddress: string;
}

export interface IContributionReceipt {
  txHash: string;
}

export interface IContributionConfirmedEvent {
  userAccountAddress: string;
  dataHash: string;
  txHash: string;
  confirmedAtEpoch: number;
}

export type ContributionConfirmedCallback = (event: IContributionConfirmedEvent) => Promise<void>;
export type Unsubscribe = () => void;

export interface IBlockchainService {
  provisionUserAccount(userId: string): Promise<IUserOnChainAccount>;
  submitContribution(params: {
    userAccountAddress: string;
    dataHash: string;
  }): Promise<IContributionReceipt>;
  onContributionConfirmed(callback: ContributionConfirmedCallback): Unsubscribe;
  getTokenBalance(accountAddress: string): Promise<bigint>;
}
```

Rules the interface must satisfy — never break these:
- All types use plain `string` for addresses, not `0x${string}` or chain-specific formats.
- `dataHash` is opaque to the port — the adapter owns the casting.
- `Unsubscribe` is a plain function so callers can clean up on shutdown.
- No mentions of ERC-4337, UserOperation, session key, PDA, ATA — those are adapter concerns.

---

## Step 3 — ABI files

**New directory:** `src/adapters/implementations/output/blockchain/abis/`

Create four files. Use `as const` on every array so viem can infer argument types.

### 3a — `aegisToken.abi.ts`

```typescript
export const aegisTokenAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
```

### 3b — `rewardController.abi.ts`

```typescript
export const rewardControllerAbi = [
  {
    name: "claimReward",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "dataHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "DataContributed",
    type: "event",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "dataHash", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
```

### 3c — `jarvisAccountFactory.abi.ts`

```typescript
export const jarvisAccountFactoryAbi = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getAddress",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
```

> If the deployed factory omits the `salt` param, remove it from both entries above
> and remove the salt derivation in step 4a.

### 3d — `entryPoint.abi.ts`

Minimal ABI — included for future use. Not called in this plan.

```typescript
export const entryPointAbi = [
  {
    name: "getUserOpHash",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "userOp",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "callGasLimit", type: "uint256" },
          { name: "verificationGasLimit", type: "uint256" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "maxFeePerGas", type: "uint256" },
          { name: "maxPriorityFeePerGas", type: "uint256" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;
```

---

## Step 4 — AvalancheBlockchainService

**New file:** `src/adapters/implementations/output/blockchain/avalanche.blockchain.ts`

### 4a — Imports and class skeleton

```typescript
import { createPublicClient, createWalletClient, http, keccak256, toBytes, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import type {
  IBlockchainService,
  IUserOnChainAccount,
  IContributionReceipt,
  IContributionConfirmedEvent,
  ContributionConfirmedCallback,
  Unsubscribe,
} from "../../../../use-cases/interface/output/blockchain.interface";
import { aegisTokenAbi } from "./abis/aegisToken.abi";
import { rewardControllerAbi } from "./abis/rewardController.abi";
import { jarvisAccountFactoryAbi } from "./abis/jarvisAccountFactory.abi";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";

export interface AvalancheBlockchainConfig {
  rpcUrl: string;
  botPrivateKey: `0x${string}`;
  tokenAddress: `0x${string}`;
  rewardControllerAddress: `0x${string}`;
  accountFactoryAddress: `0x${string}`;
}

export class AvalancheBlockchainService implements IBlockchainService {
  private readonly publicClient;
  private readonly walletClient;
  private readonly botAddress: `0x${string}`;

  constructor(private readonly config: AvalancheBlockchainConfig) {
    const account = privateKeyToAccount(config.botPrivateKey);
    this.botAddress = account.address;

    const transport = http(config.rpcUrl);

    this.publicClient = createPublicClient({
      chain: avalancheFuji,
      transport,
    });

    this.walletClient = createWalletClient({
      account,
      chain: avalancheFuji,
      transport,
    });
  }
  // methods below
}
```

### 4b — `provisionUserAccount(userId)`

Logic:
1. Derive a deterministic `salt` from `userId` so each user gets a unique smart account.
2. Compute the counterfactual account address using the factory's `getAddress` view function.
3. Check if the account bytecode is already deployed (`getCode`). If deployed, return the address without re-deploying — this makes the method safe to call multiple times.
4. If not deployed: call `createAccount` on the factory. The bot wallet pays gas.
5. Return `{ accountAddress }`. The `eoaAddress` stored in the DB is the bot's EOA address (it is the initial owner of all smart accounts).

```typescript
async provisionUserAccount(userId: string): Promise<IUserOnChainAccount> {
  const salt = keccak256(toBytes(userId));

  const accountAddress = await this.publicClient.readContract({
    address: this.config.accountFactoryAddress,
    abi: jarvisAccountFactoryAbi,
    functionName: "getAddress",
    args: [this.botAddress, salt],
  });

  const code = await this.publicClient.getCode({ address: accountAddress });
  const alreadyDeployed = code !== undefined && code !== "0x";

  if (!alreadyDeployed) {
    await this.walletClient.writeContract({
      address: this.config.accountFactoryAddress,
      abi: jarvisAccountFactoryAbi,
      functionName: "createAccount",
      args: [this.botAddress, salt],
    });
  }

  return { accountAddress: getAddress(accountAddress) };
}
```

> `getAddress` from viem normalises the checksum of the returned address.
> The `eoaAddress` to store in `user_profiles` is `this.botAddress` — the caller in auth.usecase.ts handles that.

### 4c — `submitContribution({ userAccountAddress, dataHash })`

The bot wallet holds `CLAIMER_ROLE` on RewardController and calls `claimReward` directly. This is a standard EOA transaction, not a UserOperation. The `dataHash` arrives as a `0x`-prefixed 32-byte hex string from the caller.

```typescript
async submitContribution(params: {
  userAccountAddress: string;
  dataHash: string;
}): Promise<IContributionReceipt> {
  const txHash = await this.walletClient.writeContract({
    address: this.config.rewardControllerAddress,
    abi: rewardControllerAbi,
    functionName: "claimReward",
    args: [
      params.userAccountAddress as `0x${string}`,
      params.dataHash as `0x${string}`,
    ],
  });

  return { txHash };
}
```

### 4d — `onContributionConfirmed(callback)`

Uses viem's `watchContractEvent` to subscribe to the `DataContributed` event on RewardController. The returned `unwatch` function is passed directly back as `Unsubscribe`.

```typescript
onContributionConfirmed(callback: ContributionConfirmedCallback): Unsubscribe {
  const unwatch = this.publicClient.watchContractEvent({
    address: this.config.rewardControllerAddress,
    abi: rewardControllerAbi,
    eventName: "DataContributed",
    onLogs: async (logs) => {
      for (const log of logs) {
        if (!log.args.user || !log.args.dataHash || !log.transactionHash) continue;
        await callback({
          userAccountAddress: log.args.user,
          dataHash: log.args.dataHash,
          txHash: log.transactionHash,
          confirmedAtEpoch: newCurrentUTCEpoch(),
        });
      }
    },
  });

  return unwatch;
}
```

### 4e — `getTokenBalance(accountAddress)`

```typescript
async getTokenBalance(accountAddress: string): Promise<bigint> {
  const balance = await this.publicClient.readContract({
    address: this.config.tokenAddress,
    abi: aegisTokenAbi,
    functionName: "balanceOf",
    args: [accountAddress as `0x${string}`],
  });

  return balance;
}
```

---

## Step 5 — Add `findByContributionDataHash` to evaluation log repo

The event listener callback needs to look up a log by its data hash to call `markContributed`.

### 5a — `src/use-cases/interface/output/repository/evaluationLog.repo.ts`

Add one method to `IEvaluationLogDB`:

```typescript
findByContributionDataHash(dataHash: string): Promise<EvaluationLog | null>;
```

### 5b — `src/adapters/implementations/output/sqlDB/repositories/evaluationLog.repo.ts`

Add to `DrizzleEvaluationLogRepo`:

```typescript
async findByContributionDataHash(dataHash: string): Promise<EvaluationLog | null> {
  const rows = await this.db
    .select()
    .from(evaluationLogs)
    .where(eq(evaluationLogs.contributionDataHash, dataHash))
    .limit(1);

  if (!rows[0]) return null;
  return {
    ...rows[0],
    reasoningTrace: rows[0].reasoningTrace ?? undefined,
    promptTokens: rows[0].promptTokens ?? undefined,
    completionTokens: rows[0].completionTokens ?? undefined,
    implicitSignal: rows[0].implicitSignal ?? undefined,
    explicitRating: rows[0].explicitRating ?? undefined,
    outcomeConfirmed: rows[0].outcomeConfirmed ?? undefined,
    contributedAtEpoch: rows[0].contributedAtEpoch ?? undefined,
    contributionTxHash: rows[0].contributionTxHash ?? undefined,
    contributionDataHash: rows[0].contributionDataHash ?? undefined,
  };
}
```

---

## Step 6 — ContributeDataTool

### 6a — `src/helpers/enums/toolType.enum.ts`

Add:
```typescript
CONTRIBUTE_DATA = "contribute_data",
```

### 6b — `src/adapters/implementations/output/tools/contributeData.tool.ts`

```typescript
import { createHash } from "crypto";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../use-cases/interface/output/tool.interface";
import type { IBlockchainService } from "../../../../use-cases/interface/output/blockchain.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IEvaluationLogDB } from "../../../../use-cases/interface/output/repository/evaluationLog.repo";

export class ContributeDataTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly blockchainService: IBlockchainService,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly evaluationLogRepo: IEvaluationLogDB,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CONTRIBUTE_DATA,
      description:
        "Submits the user's eligible evaluation records to the Aegis dataset on-chain and claims AGS token rewards. Call this when the user asks to contribute their data or claim rewards.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    const profile = await this.userProfileRepo.findByUserId(this.userId);
    if (!profile?.smartAccountAddress) {
      return {
        success: false,
        error: "Smart account not provisioned for this user. Contact support.",
      };
    }

    const logs = await this.evaluationLogRepo.findContributable(this.userId);
    const eligible = logs.filter(
      (l) => l.implicitSignal !== null && l.implicitSignal !== undefined ||
             l.explicitRating !== null && l.explicitRating !== undefined,
    );

    if (eligible.length === 0) {
      return { success: true, data: "No eligible records to contribute yet." };
    }

    let submitted = 0;
    const errors: string[] = [];

    for (const log of eligible) {
      const rawHash = createHash("sha256")
        .update(`${this.userId}${log.id}${log.implicitSignal ?? ""}${log.createdAtEpoch}`)
        .digest("hex");
      const dataHash = `0x${rawHash}` as const;

      try {
        await this.blockchainService.submitContribution({
          userAccountAddress: profile.smartAccountAddress,
          dataHash,
        });
        submitted++;
      } catch (err) {
        errors.push(log.id);
        console.error(`contribute_data: failed for log ${log.id}`, err);
      }
    }

    const errorSuffix = errors.length > 0
      ? ` ${errors.length} failed — they will be retried next time.`
      : "";

    return {
      success: true,
      data: `${submitted} record${submitted !== 1 ? "s" : ""} submitted for contribution. Rewards will be credited to your account once confirmed on-chain.${errorSuffix}`,
    };
  }
}
```

> The on-chain confirmation and `markContributed` DB update happen separately via the event listener (step 7), not here. The tool only submits and reports.

---

## Step 7 — Event listener wiring in `telegramCli.ts`

### 7a — Import

Add to the imports at the top of `src/telegramCli.ts`:

```typescript
import type { Unsubscribe } from "./use-cases/interface/output/blockchain.interface";
```

### 7b — Start the listener after `notificationRunner.start()`

After the `notificationRunner.start()` line:

```typescript
let unsubscribeBlockchain: Unsubscribe | null = null;

if (process.env.JARVIS_ACCOUNT_FACTORY_ADDRESS && process.env.BOT_PRIVATE_KEY) {
  const blockchainService = inject.getBlockchainService();
  unsubscribeBlockchain = blockchainService.onContributionConfirmed(async (event) => {
    const log = await sqlDB.evaluationLogs.findByContributionDataHash(event.dataHash);
    if (!log) return;
    await sqlDB.evaluationLogs.markContributed(
      log.id,
      event.txHash,
      event.dataHash,
      event.confirmedAtEpoch,
    );
  });
}
```

### 7c — Clean up on SIGINT

Inside the `SIGINT` handler, before `process.exit(0)`:

```typescript
if (unsubscribeBlockchain) unsubscribeBlockchain();
```

> The guard on `JARVIS_ACCOUNT_FACTORY_ADDRESS` and `BOT_PRIVATE_KEY` allows the app to boot without blockchain config. If either is absent, the listener is skipped silently.

---

## Step 8 — Auth use case wiring

### 8a — `src/use-cases/implementations/auth.usecase.ts`

Add `IBlockchainService` and `IUserProfileDB` to the constructor. Call `provisionUserAccount` after the user is created in `register()`.

Full updated constructor signature:
```typescript
constructor(
  private readonly userDB: IUserDB,
  private readonly jwtSecret: string,
  private readonly jwtExpiresIn: string,
  private readonly blockchainService: IBlockchainService | null,
  private readonly userProfileRepo: IUserProfileDB | null,
)
```

Both new deps are nullable so the system boots without blockchain config. If `blockchainService` is `null`, skip provisioning silently.

Updated `register()` method — add after `await this.userDB.create(...)`:

```typescript
if (this.blockchainService && this.userProfileRepo) {
  try {
    const { accountAddress } = await this.blockchainService.provisionUserAccount(userId);
    await this.userProfileRepo.upsert({
      userId,
      personalities: [],
      wakeUpHour: null,
    });
    await this.userProfileRepo.updateSmartAccount(userId, accountAddress, botEOA);
  } catch (err) {
    console.error("auth.register: smart account provisioning failed", err);
  }
}
```

The `botEOA` is not available in auth.usecase — pass it as a constructor parameter from DI:

```typescript
constructor(
  private readonly userDB: IUserDB,
  private readonly jwtSecret: string,
  private readonly jwtExpiresIn: string,
  private readonly blockchainService: IBlockchainService | null,
  private readonly userProfileRepo: IUserProfileDB | null,
  private readonly botEOA: string | null,
)
```

`botEOA` is set in DI as `process.env.BOT_PRIVATE_KEY` resolved to the EOA via `privateKeyToAccount` — but `auth.usecase.ts` must not import viem. Instead, derive the address in DI and pass the string directly (see step 11).

### 8b — Add import to auth.usecase.ts

```typescript
import type { IBlockchainService } from "../interface/output/blockchain.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
```

---

## Step 9 — Add `contribute()` to AssistantUseCase

The `/contribute` Telegram command calls this directly — no LLM routing.

### 9a — `src/use-cases/interface/input/assistant.interface.ts`

Add to `IAssistantUseCase`:

```typescript
contribute(userId: string): Promise<{ submitted: number; message: string }>;
```

### 9b — `src/use-cases/implementations/assistant.usecase.ts`

Add `IBlockchainService` as an optional last parameter to the constructor:

```typescript
constructor(
  private readonly speechToText: ISpeechToText,
  private readonly orchestrator: ILLMOrchestrator,
  private readonly registryFactory: (userId: string) => IToolRegistry,
  private readonly conversationRepo: IConversationDB,
  private readonly messageRepo: IMessageDB,
  private readonly jarvisConfigRepo: IJarvisConfigDB,
  private readonly userProfileRepo: IUserProfileDB,
  private readonly embeddingService: IEmbeddingService,
  private readonly vectorStore: IVectorStore,
  private readonly textGenerator: ITextGenerator,
  private readonly evaluationLogRepo: IEvaluationLogDB,
  private readonly userMemoryRepo: IUserMemoryDB,
  private readonly blockchainService: IBlockchainService | null = null,
)
```

Add the `contribute()` implementation:

```typescript
async contribute(userId: string): Promise<{ submitted: number; message: string }> {
  if (!this.blockchainService) {
    return { submitted: 0, message: "Blockchain integration is not configured." };
  }

  const profile = await this.userProfileRepo.findByUserId(userId);
  if (!profile?.smartAccountAddress) {
    return { submitted: 0, message: "Your on-chain account is not set up yet. Please contact support." };
  }

  const logs = await this.evaluationLogRepo.findContributable(userId);
  const eligible = logs.filter(
    (l) => (l.implicitSignal !== null && l.implicitSignal !== undefined) ||
            (l.explicitRating !== null && l.explicitRating !== undefined),
  );

  if (eligible.length === 0) {
    return { submitted: 0, message: "No eligible records found. Keep using JARVIS and try again later." };
  }

  let submitted = 0;
  for (const log of eligible) {
    const rawHash = createHash("sha256")
      .update(`${userId}${log.id}${log.implicitSignal ?? ""}${log.createdAtEpoch}`)
      .digest("hex");
    const dataHash = `0x${rawHash}`;
    try {
      await this.blockchainService.submitContribution({
        userAccountAddress: profile.smartAccountAddress,
        dataHash,
      });
      submitted++;
    } catch (err) {
      console.error(`contribute: submission failed for log ${log.id}`, err);
    }
  }

  const message = submitted > 0
    ? `${submitted} record${submitted !== 1 ? "s" : ""} submitted. AGS rewards will appear in your account once confirmed on-chain.`
    : "All submissions failed. Please try again later.";

  return { submitted, message };
}
```

Add import at the top of assistant.usecase.ts:

```typescript
import { createHash } from "crypto";
import type { IBlockchainService } from "../interface/output/blockchain.interface";
```

> Note: `contribute()` and `ContributeDataTool.execute()` share the same hash computation and submission logic. Both paths exist intentionally: the tool is for LLM-initiated contribution (organic conversation), the use case method is for the explicit `/contribute` command (direct command path). They are independent code paths with the same behaviour — do not try to deduplicate them across layer boundaries.

---

## Step 10 — Telegram `/contribute` command

### `src/adapters/implementations/input/telegram/handler.ts`

Add the command inside `register(bot: Bot)`, alongside the other `bot.command(...)` calls:

```typescript
bot.command("contribute", async (ctx) => {
  const session = await this.ensureAuthenticated(ctx.chat.id);
  if (!session) {
    await ctx.reply("Please authenticate first. Use /auth <token>.");
    return;
  }
  await ctx.replyWithChatAction("typing");
  try {
    const result = await this.assistantUseCase.contribute(session.userId);
    await ctx.reply(result.message);
  } catch (err) {
    console.error("Error handling /contribute:", err);
    await ctx.reply("Something went wrong. Please try again.");
  }
});
```

No new constructor dependencies for `TelegramAssistantHandler` — it already holds `assistantUseCase`.

---

## Step 11 — DI wiring (`assistant.di.ts`)

### 11a — Add `getBlockchainService()` singleton

Add a private field and a getter to `AssistantInject`:

```typescript
private _blockchainService: AvalancheBlockchainService | null = null;
```

```typescript
getBlockchainService(): AvalancheBlockchainService | null {
  const rpcUrl = process.env.AVAX_RPC_URL;
  const botPrivateKey = process.env.BOT_PRIVATE_KEY;
  const tokenAddress = process.env.AEGIS_TOKEN_ADDRESS;
  const rewardControllerAddress = process.env.REWARD_CONTROLLER_ADDRESS;
  const accountFactoryAddress = process.env.JARVIS_ACCOUNT_FACTORY_ADDRESS;

  if (!rpcUrl || !botPrivateKey || !tokenAddress || !rewardControllerAddress || !accountFactoryAddress) {
    return null;
  }

  if (!this._blockchainService) {
    this._blockchainService = new AvalancheBlockchainService({
      rpcUrl,
      botPrivateKey: botPrivateKey as `0x${string}`,
      tokenAddress: tokenAddress as `0x${string}`,
      rewardControllerAddress: rewardControllerAddress as `0x${string}`,
      accountFactoryAddress: accountFactoryAddress as `0x${string}`,
    });
  }

  return this._blockchainService;
}
```

Import at the top:
```typescript
import { AvalancheBlockchainService } from "../implementations/output/blockchain/avalanche.blockchain";
import { privateKeyToAccount } from "viem/accounts";
```

### 11b — Update `getUseCase()` — pass blockchainService as last arg

In the `new AssistantUseCaseImpl(...)` call, add `this.getBlockchainService()` as the final argument.

### 11c — Update `getAuthUseCase()` — pass blockchainService, userProfileRepo, botEOA

Replace:
```typescript
this._authUseCase = new AuthUseCaseImpl(
  this.getSqlDB().users,
  process.env.JWT_SECRET ?? "",
  process.env.JWT_EXPIRES_IN ?? "7d",
);
```

With:
```typescript
const botPrivateKey = process.env.BOT_PRIVATE_KEY;
const botEOA = botPrivateKey
  ? privateKeyToAccount(botPrivateKey as `0x${string}`).address
  : null;

this._authUseCase = new AuthUseCaseImpl(
  this.getSqlDB().users,
  process.env.JWT_SECRET ?? "",
  process.env.JWT_EXPIRES_IN ?? "7d",
  this.getBlockchainService(),
  this.getSqlDB().userProfiles,
  botEOA,
);
```

### 11d — Register `ContributeDataTool` in the tool registry

In `registryFactory` inside `getUseCase()`, add after the `WebSearchTool` registration:

```typescript
const blockchainService = this.getBlockchainService();
if (blockchainService) {
  r.register(
    new ContributeDataTool(
      userId,
      blockchainService,
      sqlDB.userProfiles,
      sqlDB.evaluationLogs,
    ),
  );
}
```

Import at the top:
```typescript
import { ContributeDataTool } from "../implementations/output/tools/contributeData.tool";
```

---

## Step 12 — `.env.example`

Add the following block (these keys are already documented in status.md but the `.env.example` file must include them):

```bash
# Blockchain (Avalanche Fuji) — leave blank to disable blockchain features
AVAX_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
BOT_PRIVATE_KEY=                          # hex private key of 0xc018...ec078 (holds CLAIMER_ROLE)
AEGIS_TOKEN_ADDRESS=0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69
REWARD_CONTROLLER_ADDRESS=0x519092C2185E4209B43d3ea40cC34D39978073A7
JARVIS_ACCOUNT_FACTORY_ADDRESS=           # set after JarvisAccountFactory is deployed
ENTRY_POINT_ADDRESS=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
```

> All six vars must be set for blockchain features to activate. If any is missing, `getBlockchainService()` returns `null` and all blockchain paths silently no-op (registered in step 11a).

---

## Summary of all file changes

| File | Action |
|---|---|
| `src/use-cases/interface/output/blockchain.interface.ts` | **Create** — port interface |
| `src/adapters/implementations/output/blockchain/abis/aegisToken.abi.ts` | **Create** |
| `src/adapters/implementations/output/blockchain/abis/rewardController.abi.ts` | **Create** |
| `src/adapters/implementations/output/blockchain/abis/jarvisAccountFactory.abi.ts` | **Create** |
| `src/adapters/implementations/output/blockchain/abis/entryPoint.abi.ts` | **Create** |
| `src/adapters/implementations/output/blockchain/avalanche.blockchain.ts` | **Create** — concrete adapter |
| `src/use-cases/interface/output/repository/evaluationLog.repo.ts` | **Edit** — add `findByContributionDataHash` to `IEvaluationLogDB` |
| `src/adapters/implementations/output/sqlDB/repositories/evaluationLog.repo.ts` | **Edit** — implement `findByContributionDataHash` |
| `src/helpers/enums/toolType.enum.ts` | **Edit** — add `CONTRIBUTE_DATA` |
| `src/adapters/implementations/output/tools/contributeData.tool.ts` | **Create** — `ContributeDataTool` |
| `src/use-cases/interface/input/assistant.interface.ts` | **Edit** — add `contribute()` to `IAssistantUseCase` |
| `src/use-cases/implementations/assistant.usecase.ts` | **Edit** — add `blockchainService` constructor param + `contribute()` method |
| `src/use-cases/implementations/auth.usecase.ts` | **Edit** — add `blockchainService`, `userProfileRepo`, `botEOA` constructor params + provision call in `register()` |
| `src/adapters/implementations/input/telegram/handler.ts` | **Edit** — add `/contribute` command |
| `src/adapters/inject/assistant.di.ts` | **Edit** — add `getBlockchainService()`, update `getUseCase()`, update `getAuthUseCase()`, register `ContributeDataTool` |
| `src/telegramCli.ts` | **Edit** — start event listener, clean up on SIGINT |
| `.env.example` | **Edit** — add 6 blockchain env vars |

**No DB migrations needed** — all required columns already exist in `schema.ts`.

---

## Critical edge cases

| Scenario | Handling |
|---|---|
| Blockchain env vars not set | `getBlockchainService()` returns `null`; all callers guard with `if (!blockchainService)` and no-op |
| Smart account already deployed | `provisionUserAccount` checks `getCode` before calling `createAccount`; skips deployment if code exists |
| User profile row doesn't exist when provisioning in `register()` | `userProfileRepo.upsert({userId, personalities: [], wakeUpHour: null})` is called first, then `updateSmartAccount` |
| Contribution submission fails for one log | Per-log try/catch in `contribute()` — failed logs remain in `findContributable` and are retried next call |
| Event arrives but no matching log in DB | `findByContributionDataHash` returns `null`; callback returns early without error |
| `contribute()` called before smart account provisioned | Returns early with a user-facing message; does not throw |
| `dataHash` from event is a raw `bytes32` hex from viem | Already a `0x`-prefixed string — passed as-is to `findByContributionDataHash` |
