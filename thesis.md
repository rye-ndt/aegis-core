# Aegis — Investor Thesis

## The one-line pitch

Aegis is the AI-native crypto wallet for the 500 million people who want to participate in DeFi but can't navigate it — a Telegram-native agent that understands plain language, executes on-chain actions non-custodially, and proactively grows your money while you sleep.

---

## The problem: DeFi is still for insiders

**Crypto is a trillion-dollar asset class that most people can't actually use.**

The gap isn't knowledge or desire. It's interface. Today's DeFi experience requires users to:
- Copy-paste wallet addresses, juggle gas settings, and manually approve every transaction
- Trust centralized bots that demand their private key — one breach away from losing everything
- Actively monitor yield rates, manually move funds across protocols, and time the market themselves
- Leave idle stablecoins sitting untouched while losing real value to inflation

Meanwhile, 800+ million people use Telegram daily. Many already hold crypto. None of them want to be power users. They want results.

---

## The opportunity

Three trends are converging right now:

1. **Account abstraction (ERC-4337) is live.** Smart Contract Accounts allow session-key delegation — users can authorize an agent to act on their behalf without ever handing over the master key.

2. **LLMs are good enough to parse intent.** "Send $50 USDC to @mike" is now a fully resolvable instruction. The translation layer from natural language to on-chain calldata works.

3. **Telegram Mini Apps are mainstream.** Over 300 million users interact with Telegram Mini Apps monthly. The distribution channel already exists and has deep penetration in crypto-native markets.

The window to own the "AI-native DeFi wallet" category is open. It will not stay open long.

---

## Our solution: Aegis

Aegis is a Telegram-native AI agent that lets anyone execute DeFi actions — sending, swapping, and earning yield — through a natural language conversation, with no private key exposure, no complex UI, and no manual monitoring.

### What users actually experience

- **"Send 50 USDC to @alice"** — Aegis resolves Alice's wallet from her Telegram handle, estimates gas, shows a plain-English preview, and executes via a one-tap approval in the mini-app.
- **"Swap my ETH for AVAX"** — Aegis finds the best route across chains via Relay, sequences the transactions, and keeps the mini-app open until every step is signed.
- **"Earn yield on my USDC"** — Aegis proactively detects idle USDC, suggests the highest-scoring Aave pool (ranked by a 7-day EMA algorithm), and moves funds with a single approval. A daily PnL report lands in Telegram every morning.
- **"How much did I spend on gas last month?"** — The AI assistant answers from on-chain data via tool calls.

### Why it's defensible

| What we do | What competitors do |
|---|---|
| Session key delegation — the backend never holds a private key | Most bots require key export |
| Intent-based NL → calldata pipeline | Fixed command menus |
| Proactive yield engine with daily nudges | Passive, user must act |
| Modular Capability system — any DeFi action can be added as a plugin | Monolithic, centralized roadmap |
| Loyalty points rewarding on-chain activity | No retention mechanics |

**The core moat is trust.** Non-custodial execution is not a feature — it is the only architecture that can scale to mainstream users who've been burned by custodial failures (FTX, Binance, etc.). Our session-key model gives users full control without the UX burden.

---

## Business model

### Primary: Protocol fee on execution
Every swap, send, and yield deposit settled through Aegis carries a small protocol fee baked into the transaction. This is invisible to the user — the gas abstraction layer absorbs the complexity.

### Secondary: Premium features
- **Aegis Guard** — customizable per-token spending limits; advanced controls for power users.
- **Loyalty Season passes** — seasonal point multipliers and rewards for high-volume users.
- **Developer tools** — custom HTTP tool registration (enterprises and protocols plug their products into the agent's capability layer).

### Tertiary: Ecosystem partnerships
Protocol integrations (lending, DEXs, liquid staking) pay for placement in the yield ranker and capability registry. This is similar to how aggregators charge protocols for priority routing.

---

## Traction & current state

**The product is live and fully functional on Avalanche mainnet.**

- Non-custodial send, swap, and yield deposit/withdraw are all production-ready.
- Loyalty Season 0 is seeded and active — daily on-chain activity is already being rewarded.
- A deployed Cloud Run backend handles real user sessions with structured observability (pino logs, Prometheus-compatible metrics).
- The Telegram bot and Mini App are integrated end-to-end: auth, session key delegation, signing, confirmation, and failure recovery (including an insufficient-balance recovery flow that automatically prompts the user to top up via MoonPay).

---

## Why now

- **Account abstraction reached production maturity in 2023–2024.** ZeroDev and Pimlico have hardened the infrastructure. Building on ERC-4337 today is like building on AWS in 2008.
- **OpenAI's function-calling API makes intent parsing production-viable.** The NL → structured JSON pipeline is reliable enough to trust with real money.
- **Telegram's mini-app ecosystem is at an inflection point.** The platform added payment rails and native TON wallet integration in 2024; DeFi mini-apps are the obvious next layer.
- **Regulatory clarity is improving.** The shift in US regulatory posture creates a window to build consumer-facing on-chain products that were previously too risky to market.

---

## Roadmap

### Now (Avalanche mainnet)
- Send, swap (cross-chain via Relay), yield (Aave v3 USDC)
- Loyalty Season 0 with 7 action types
- Non-custodial execution via ZeroDev session keys
- Proactive daily yield reports and idle-fund nudges
- P2P notification — recipients get notified when they receive a transfer

### Next (6 months)
- Multi-chain expansion (Base, Arbitrum, Polygon, Optimism) — chain config is already abstracted
- Additional yield protocols (Benqi, Yearn) — adapter interface is pluggable
- Onramp via MoonPay webhook (buy → watch deposit → auto-invest)
- Proactive market intelligence — daily sentiment → personalized position suggestions
- Mobile push notifications via Telegram channel

### Later (12 months)
- Agent-to-agent marketplace — third-party protocols publish Capability plugins
- Institutional Aegis Guard — treasury management for DAOs and funds
- Referral program with on-chain reward distribution

---

## Team

Built by founders who have shipped production DeFi infrastructure and understand both the technical depth (hexagonal architecture, ERC-4337, cross-chain execution) and the consumer product challenge (Telegram-native UX, non-technical user flows, trust-first design).

---

## Ask

We are raising a **pre-seed round** to:
1. Expand the team (2 engineers, 1 growth)
2. Cover protocol integration costs and ecosystem partnership deals
3. Fund user acquisition through crypto communities and Telegram growth channels
4. Scale infrastructure to 10x current user capacity

**The architecture is built to scale. The moat is the user relationship. The timing is now.**

---

*Aegis — own your keys, not your complexity.*
