# Onchain Agent — Status

> Last updated: 2026-04-09 (dynamic tool registry — parts 1 & 2)

---

## Vision

A non-custodial, intent-based AI trading agent on Avalanche. Users state natural language intents (e.g., "Buy $100 of AVAX"), the AI parses the intent, and the bot executes the on-chain swap via an ERC-4337 Smart Account using Session Key delegation.

The user never holds a private key. The bot's Master Session Key signs `UserOperation`s on their behalf, authorized by their smart account. Every execution automatically routes a 1% protocol fee to the treasury.

---

## What it is (current implementation)

A fully wired intent-based AI trading agent on Telegram backed by Hexagonal Architecture. Users authenticate via JWT (register/login via HTTP API, then `/auth <token>` in Telegram). The agent can answer questions, execute web searches, parse trading intents, simulate them via ERC-4337 UserOperations, and submit them on-chain via Session Keys.

**Phase 1 (purge) ✅ — Phase 2 (infrastructure) ✅ — Phase 3 (execution engine) ✅ — Phase 4 (token crawler) ✅ — Phase 5 (token enrichment) ✅ — Phase 6 (dynamic tool registry, parts 1–2 of 3) 🔄**
