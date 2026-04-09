# Business Model — Onchain Agent

## Problem

Interacting with DeFi protocols is still inaccessible to most users. Swapping tokens, managing liquidity, or bridging assets requires navigating fragmented UIs, understanding slippage, gas estimation, and wallet management. Even experienced users make costly mistakes.

There is no product today that lets a non-technical user state a plain-language financial intent and have it executed safely and non-custodially on-chain.

---

## Solution

An intent-based AI trading agent on Avalanche, accessible via Telegram. Users describe what they want in plain English ("Swap 50 USDC to AVAX with low slippage"). The agent:

1. Parses the intent into a strict structured action.
2. Fetches a live quote from the DEX (Trader Joe).
3. Simulates the transaction to check balance, slippage, and honeypot risk.
4. Executes via the user's ERC-4337 Smart Account using a delegated Session Key.

The user never touches a private key. Execution is non-custodial and trustless.

---

## Revenue Model

Every on-chain execution routes a **1% protocol fee** to the treasury address automatically, embedded in the transaction builder. No user opt-in required — it is a protocol-level deduction applied before the swap.

| Stream              | Mechanism                                                         |
| ------------------- | ----------------------------------------------------------------- |
| Protocol fee        | 1% of every executed swap/action routes to treasury              |
| Premium access      | Future: higher swap limits, priority execution lanes             |
| Ecosystem grants    | Avalanche Foundation and DeFi protocol grants for early traction |

---

## Value Propositions

**For users:**
- No wallet setup required — a smart account is provisioned automatically on registration.
- No manual transaction signing — Session Key delegation handles execution.
- Safety by design — simulation layer rejects honeypots, excessive slippage, and insufficient balance before execution.
- Natural language interface — no need to understand ABIs, gas, or DEX routing.

**For the protocol:**
- Fee accrual on every executed intent, at the protocol layer.
- Non-custodial by design — zero user private key exposure, minimal regulatory surface.
- Composable — the execution engine can extend to any EVM-compatible action (lending, bridging, staking).

---

## How it works (target architecture)

```
User: "Buy $100 of AVAX"
         │
         ▼
Intent Parser (LLM)
  → { action: SWAP, tokenIn: USDC, tokenOut: AVAX, amount: 100, slippage: 0.5 }
         │
         ▼
Deterministic Safety Layer
  → Fetch DEX quote (Trader Joe API)
  → Check Smart Account balance
  → Simulate transaction (revert detection, slippage guard)
  → Inject 1% protocol fee into calldata
         │
         ▼
ERC-4337 Execution
  → Build UserOperation
  → Sign with Bot's Master Session Key
  → Submit to Avalanche EntryPoint
         │
         ▼
User receives: "Swapped 100 USDC → X AVAX. Tx: 0x..."
```

---

## Non-Negotiable Constraints

- **Zero custody:** User private keys are never generated, stored, or logged.
- **Deterministic execution:** The LLM proposes; the safety layer decides. The LLM cannot sign or submit transactions directly.
- **Fail-safe:** If the DEX API fails, gas spikes, or simulation reverts — halt and inform the user. Never partial-execute.
- **Type safety:** Every LLM output and external API response is validated with Zod before use.

---

## Competitive Position

- **vs. CEX trading bots:** Fully non-custodial. Users keep self-sovereignty.
- **vs. manual DeFi:** Zero friction — no wallet management, no UI navigation.
- **vs. custodial AI agents:** Session Key delegation means the bot can act but never own assets.

---

## Roadmap

| Phase | Description                                      | Status      |
| ----- | ------------------------------------------------ | ----------- |
| 1     | Codebase purge — remove old business model       | ✅ Complete  |
| 2     | Anthropic orchestrator + wallet provisioning     | Pending     |
| 3     | Intent parser + safety layer + fee injection     | Pending     |
| 4     | DEX execution + UserOperation submission         | Pending     |
| 5     | Multi-action support (lending, bridging, staking)| Future      |
