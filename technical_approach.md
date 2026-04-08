# Technical Approach — Aegis

## Problem Statement

Training a high-quality AI assistant requires feedback data that captures real user intent: what actions the agent took, whether those actions were correct, and what context surrounded them. This data is expensive to produce artificially and nearly impossible to crowdsource at the depth required. The technical challenge is: **how do you collect this data continuously, unobtrusively, and in a way that can be verified and traded without trusting a central party?**

---

## Architecture Overview

Aegis is a TypeScript/Node.js system built on the Hexagonal (Ports & Adapters) pattern. All business logic lives in use-cases; every external dependency (LLM, DB, blockchain) is behind an interface. This means the orchestration model, storage layer, or chain can be swapped without touching core logic.

```
User (Telegram / voice / photo)
        │
        ▼
TelegramAssistantHandler
        │
        ▼
AssistantUseCaseImpl          ← pure business logic
   │         │
   ▼         ▼
ILLMOrchestrator    IToolRegistry
(OpenAI gpt-4o)     (calendar, gmail, memory, search, contribute)
        │
        ▼
Post-processing pipeline (setImmediate — non-blocking)
   - Implicit feedback detection
   - Memory extraction → Pinecone upsert
   - evaluation_logs write
```

---

## Data Collection Pipeline

Every agent turn produces an `evaluation_log` row containing:

| Field | Contents |
| ----- | -------- |
| `system_prompt_hash` | Fingerprint of the exact prompt used |
| `memories_injected` | Which semantic memories were retrieved and injected |
| `tool_calls` | Full sequence of tools called, params, and results |
| `reasoning_trace` | Chain-of-thought steps emitted before/after tool calls |
| `response` | Final assistant reply |
| `prompt_tokens` / `completion_tokens` | LLM usage |
| `implicit_signal` | LLM-detected feedback signal: correction / repeat / clarification / positive |
| `explicit_rating` | User-provided 1–5 rating (pending `/rate` command) |
| `outcome_confirmed` | Whether the user confirmed the action succeeded |

**Implicit feedback detection** runs asynchronously after every turn, looking back `FEEDBACK_WINDOW_SIZE` (default 3) messages. The LLM classifies whether the user's follow-up implies a correction, repetition, or positive confirmation. This produces a continuous stream of labeled data without requiring the user to explicitly rate anything.

---

## Memory System

Two layers:

1. **Short-term:** sliding window of the last 20 uncompressed messages, with LLM-generated summary prepended when total tokens exceed 80k.
2. **Long-term:** facts extracted from conversation → embedded (OpenAI `text-embedding-3-small`) → stored in Pinecone. Semantic search at the start of every turn retrieves the top 5 memories with score ≥ 0.75 and injects them into the system prompt.

This gives the agent a persistent user model that survives across conversation threads.

---

## Contribution Flow (target design)

1. **User triggers `/contribute`** in Telegram.
2. System queries `evaluation_logs` for uncontributed records (`contributed_at_epoch IS NULL`) belonging to the user, filtered for records with a meaningful feedback signal (implicit or explicit).
3. User is presented a summary of candidate records and selects which to contribute.
4. For each selected record, the system computes: `dataHash = sha256(userId + logId + feedbackSignal + createdAtEpoch)`.
5. The bot wallet (holding `CLAIMER_ROLE`) calls `RewardController.claimReward(userSmartAccount, dataHash)` via ERC-4337 UserOperation, signed with its session key.
6. `RewardController` mints 10 AGS to the user's smart account (capped at 5 contributions/day).
7. A `DataContributed` event is emitted on-chain. An event listener updates `evaluation_logs.contributed_at_epoch`, `contribution_tx_hash`, `contribution_data_hash`.

The on-chain record gives each contribution a verifiable timestamp and a content hash. The off-chain `evaluation_log` is the full payload. Together they form a provenance-linked record: the buyer sees the hash on-chain and can verify it matches the data they receive.

---

## Blockchain Layer (Avalanche Fuji → Mainnet)

| Component | Address | Role |
| --------- | ------- | ---- |
| AegisToken (proxy) | `0x8839ecFB1BefD232d5Fcf55C223BDD78bc3A2f69` | ERC-20 reward token |
| RewardController (proxy) | `0x519092C2185E4209B43d3ea40cC34D39978073A7` | Mints AGS on valid contribution claim |
| SessionKeyFactory | `0x160E43075D9912FFd7006f7Ad14f4781C7f0D443` | Deploys ERC-4337 smart accounts for users |
| SessionKeyManager | `0xA5264f7599B031fDD523Ab66f6B6FA86ce56d291` | Manages bot session key authorization |
| ERC-4337 EntryPoint | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | Standard ERC-4337 entrypoint |

**ERC-4337 + Session Keys** allow the bot to submit on-chain transactions on behalf of the user without requiring the user to hold ETH/AVAX or sign anything. On registration, the system calls `SessionKeyFactory` to deploy a smart account for the user and authorize the bot's EOA as a session key. All subsequent on-chain actions (reward claims, future dataset purchases) use this key.

---

## What Is Not Yet Decided

- **Dataset access protocol.** How buyers query and receive data — API with AGS payment gate, or a decentralized data marketplace contract — is not designed.
- **On-chain/off-chain linkage for buyers.** The on-chain hash proves a contribution happened; the mechanism for buyers to request and verify the full off-chain payload is TBD (options: IPFS CID stored on-chain, trusted API, zero-knowledge proof of data integrity).
- **Federated learning integration.** Whether contributed data feeds a centrally fine-tuned model, a federated learning round, or a distributed training protocol is an open design question.
- **Fraud resistance.** Sybil attacks (fake users generating fake feedback) are the primary threat vector. Mitigations (proof-of-personhood, rate limiting, quality scoring) are not implemented.

---

## Tech Stack Summary

| Layer | Choice |
| ----- | ------ |
| Language | TypeScript 5.3, Node.js, strict mode |
| Interface | Telegram (`grammy`) + HTTP API |
| LLM | OpenAI `gpt-4o` (chat + vision + tool use) |
| STT / TTS | OpenAI Whisper + TTS-1 |
| ORM + DB | Drizzle ORM + PostgreSQL |
| Cache | Redis — system prompt, session state |
| Vector store | Pinecone (1536-dim, cosine, per-user namespace) |
| Web search | Tavily |
| Blockchain | Avalanche Fuji, ERC-4337, Viem/Ethers |
| DI | Manual container (`src/adapters/inject/`) |
