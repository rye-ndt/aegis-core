# JARVIS — Avalanche testnet Integration

> Last updated: 2026-04-06
> Network: Avalanche Fuji Testnet (Chain ID: 43113)

---

## Deployed Contracts

| Contract                         | Proxy Address                                | Implementation Address                       |
| -------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `AegisToken`                     | `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69` | `0x5bbf914473317B713B2181e930b8186E81e0E865` |
| `RewardController`               | `0x519092C2185E4209B43d3ea40cC34D39978073A7` | `0xDF9C1c4A3Df2C804d020c7b1Ead2E9ED4b1Cd357` |
| `JarvisAccount` (implementation) | —                                            | TBD on deployment                            |
| `JarvisAccountFactory`           | —                                            | TBD on deployment                            |

> Always interact with the **proxy address**, never the implementation address directly.

---

## Wallets

| Role               | Address                                      |
| ------------------ | -------------------------------------------- |
| Admin              | `0x8Cb4d128354296d2428e63cf395ffA9c3d64E54C` |
| Bot (CLAIMER_ROLE) | `0xc018E6218e4dfF7a94A8Fd4C8b6CE9A99B0ec078` |

---

## Roles

### AegisToken (`0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69`)

| Role                 | Hash                                                                 | Granted To             |
| -------------------- | -------------------------------------------------------------------- | ---------------------- |
| `DEFAULT_ADMIN_ROLE` | `0x0000000000000000000000000000000000000000000000000000000000000000` | Admin wallet           |
| `MINTER_ROLE`        | `0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6` | RewardController proxy |
| `UPGRADER_ROLE`      | `0x189ab7a9244df0848122154315af71fe140f3db0fe014031783b0946b8c9d2e3` | Admin wallet           |

### RewardController (`0x519092C2185E4209B43d3ea40cC34D39978073A7`)

| Role                 | Hash                                                                 | Granted To   |
| -------------------- | -------------------------------------------------------------------- | ------------ |
| `DEFAULT_ADMIN_ROLE` | `0x0000000000000000000000000000000000000000000000000000000000000000` | Admin wallet |
| `CLAIMER_ROLE`       | `0x11a8cb5a02bd6c42679835e867ef2118ba78f088f8300511420c6603c21d9c78` | Bot wallet   |
| `UPGRADER_ROLE`      | `0x189ab7a9244df0848122154315af71fe140f3db0fe014031783b0946b8c9d2e3` | Admin wallet |

---

## Contract Details

### AegisToken

- **Standard:** ERC-20, UUPS upgradeable
- **Name:** Aegis
- **Symbol:** AGS
- **Decimals:** 18
- **Max Supply:** 100,000,000 AGS (`100_000_000 * 10 ** 18`)
- **Minting:** Only `RewardController` can mint via `MINTER_ROLE`
- **Upgrading:** Only admin via `UPGRADER_ROLE`

### RewardController

- **Standard:** UUPS upgradeable
- **Reward per contribution:** 10 AGS (`10000000000000000000`)
- **Daily cap:** 5 contributions per user per day
- **Dedup:** On-chain via `mapping(bytes32 => bool) claimed`
- **Daily reset:** Automatic via `block.timestamp / 1 days`

Key functions:

```solidity
// Called by bot on behalf of user
claimReward(address user, bytes32 dataHash) external onlyRole(CLAIMER_ROLE)

// Admin controls
setRewardPerContribution(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE)
setDailyCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE)
```

### JarvisAccount (ERC-4337 Smart Account)

- **Standard:** ERC-4337 account abstraction, UUPS upgradeable
- **EntryPoint:** `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` (canonical v0.6)
- **Signers:** Owner (user) or Bot — both can execute transactions
- **Deployment:** One account per user, deployed via `JarvisAccountFactory`

Key functions:

```solidity
// Execute single call — called by EntryPoint or bot
execute(address target, uint256 value, bytes calldata data)

// Execute batch calls
executeBatch(address[] targets, uint256[] values, bytes[] datas)

// ERC-4337 validation
validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)

// Update bot address
updateBot(address newBot) external onlyOwner
```

### JarvisAccountFactory

- Deploys one `JarvisAccount` proxy per user
- Called by bot when a new user registers
- Stores resulting smart account address in `user_profiles`

Key functions:

```solidity
// Deploy a new smart account for a user
createAccount(address owner) external returns (address)

// Compute deterministic address before deployment
getAddress(address owner) external view returns (address)
```

---

## Contribution Flow

```
User selects contribution via /contribute in Telegram
        │
        ▼
Bot computes dataHash = sha256(userId + actionId + feedbackScore + timestamp)
        │
        ▼
Bot calls RewardController.claimReward(userAddress, dataHash)
  - checks claimed[dataHash] == false          (dedup)
  - checks dailyClaimCount[user] < dailyCap    (rate limit)
  - calls AegisToken.mint(userAddress, 10 AGS)
  - marks claimed[dataHash] = true
  - emits DataContributed(userAddress, dataHash, amount)
        │
        ▼
Bot listens for DataContributed event
  → marks contribution as claimed in DB
  → stores tx_hash in evaluation_logs
```

---

## DB Changes Required

Add to `evaluation_logs` table:

```typescript
contributed_at_epoch: integer(),   // epoch when contribution was submitted
contribution_tx_hash: text(),      // on-chain tx hash
contribution_data_hash: text(),    // bytes32 hash submitted on-chain
```

Add to `user_profiles` table:

```typescript
smart_account_address: text(),     // ERC-4337 smart account address
eoa_address: text(),               // user's raw wallet address
```

---

## JARVIS TypeScript Integration — TODO

| Task                                          | File              | Status |
| --------------------------------------------- | ----------------- | ------ |
| `/contribute` Telegram command                | `telegram/`       | ⬜     |
| `contributeData.tool.ts`                      | `tools/`          | ⬜     |
| Wallet creation on user register              | `auth.usecase.ts` | ⬜     |
| `JarvisAccountFactory` call on register       | `adapters/`       | ⬜     |
| On-chain event listener for `DataContributed` | `adapters/`       | ⬜     |
| DB migration for new columns                  | `sqlDB/schema.ts` | ⬜     |

---

## Environment Variables to Add

```bash
# Blockchain
AVAX_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
BOT_PRIVATE_KEY=                          # private key of 0xc018...ec078
AEGIS_TOKEN_ADDRESS=0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69
REWARD_CONTROLLER_ADDRESS=0x519092C2185E4209B43d3ea40cC34D39978073A7
JARVIS_ACCOUNT_FACTORY_ADDRESS=           # TBD after factory deployment
ENTRY_POINT_ADDRESS=0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
```

---

## References

- Avalanche Fuji RPC: `https://api.avax-test.network/ext/bc/C/rpc`
- Fuji Explorer: `https://testnet.snowtrace.io`
- Fuji Faucet: `https://faucet.avax.network`
- ERC-4337 EntryPoint v0.6: `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`
