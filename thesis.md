# Aegis — Investor Thesis

## The one-line pitch

Aegis is the daily intelligence layer for your on-chain money — the easiest way for Southeast Asian crypto holders to earn real DeFi yield, hold US stocks, and act on market moves through a single Telegram chat, in plain language, without ever giving up custody.

---

## The problem: Southeast Asia holds the crypto, but can't use it

Southeast Asia is one of the most crypto-saturated regions in the world. Vietnam ranks consistently in the top 5 globally for crypto adoption. The Philippines, Indonesia, and Thailand each have tens of millions of holders. These users hold stablecoins on Binance and local exchanges. They have idle USDT sitting in custodial accounts earning 1–2% — while the same dollar on-chain can earn 5–8% in Aave or comparable protocols.

They cannot access that yield, because using it requires them to:

- Bridge funds off centralized exchanges into a self-custody wallet
- Learn to use MetaMask, manage seed phrases, pay gas, and approve contracts
- Decide which protocol, which pool, which chain — and monitor it daily
- Trust a random Telegram trading bot with their private key, knowing one breach erases everything

Meanwhile, the same users are locked out of US equities entirely — you cannot open a Robinhood or Schwab account from Hanoi or Manila. They want exposure to Tesla, Nvidia, the S&P. They have no way to get it.

The result: hundreds of millions of dollars of stablecoins sitting idle in Southeast Asian retail accounts, earning nothing, while their holders watch DeFi yields and US equities from the sidelines.

---

## The opportunity

Three things are converging right now that did not exist eighteen months ago:

1. **Account abstraction (ERC-4337) is production-mature.** Smart Contract Accounts with session-key delegation let an agent execute on a user's behalf without ever holding the master key. The custodial-vs-self-custody tradeoff that has defined crypto UX is finally solvable.

2. **LLM intent parsing crossed the reliability threshold.** "Move my idle USDC into the highest-yield pool" is now a deterministic instruction. The translation layer from natural language to on-chain calldata works in production.

3. **Telegram is the de facto financial frontend in Southeast Asia.** Vietnam alone has tens of millions of daily Telegram users; the platform is where crypto communities, traders, and OTC desks already live. Telegram Mini Apps added native payment rails and TON wallet integration in 2024. The distribution channel is in place.

Tokenized US equities (via Aster) and prediction markets (via Kalshi) became accessible to non-US users on-chain in the same window. For the first time, a single agent can give a Vietnamese retail user yield on stables, exposure to Tesla, and a position on the next Fed decision — with no offshore brokerage account and no custodial trust.

The window to own the "AI-native financial command center for SEA retail" category is open. It will not stay open.

---

## Our solution: Aegis

Aegis is a Telegram-native AI agent. Every morning, the user opens it and sees:

- What their portfolio did yesterday, and _why_ — yield earned, gains and losses on positions, fees paid, gas spent
- What's at risk today — APY changes, idle balances, market moves on assets they hold
- What to do about it — one tap to compound, rebalance, hedge, or take a new position

Underneath that intelligence layer, every DeFi action is one sentence away. Send. Swap. Earn yield. Buy tokenized US stocks. Take a position on Kalshi. The agent resolves the intent, sequences the on-chain calls, and executes through ZeroDev session keys — non-custodial, no signing friction, no learning curve.

### What users actually experience

- **"Earn yield on my USDC"** — Aegis surveys Aave and other protocols, ranks by 7-day EMA, suggests the highest-scoring pool, and moves funds with one approval. A daily PnL report lands in Telegram every morning.
- **"Buy $200 of Tesla"** — Aegis routes through Aster, executes the position, and adds it to the portfolio view. No US brokerage account required.
- **"Will the Fed cut rates in June?"** — Aegis pulls live Kalshi odds and lets the user take a position from chat.
- **"Send 50 USDC to @alice"** — Resolved from Telegram handle, executed in one tap.
- **"How much did I make this week?"** — Answered from on-chain data via tool calls, in plain language.

### Why it's defensible

| What we do                                                    | What competitors do                                    |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| Daily intelligence layer — the user comes back every morning  | Reactive UIs the user opens only when they want to act |
| Session-key delegation — backend never holds a key            | Trading bots that demand seed phrase export            |
| Intent-based NL → calldata pipeline                           | Fixed command menus and clunky web UIs                 |
| Modular Capability platform — any protocol plugs in as a tool | Monolithic feature roadmaps centralized on one team    |
| Loyalty points rewarding on-chain activity                    | No retention mechanics                                 |

The core moat is two-sided. **For users**, it is trust — non-custodial execution is the only architecture that scales to a region scarred by FTX, exchange freezes, and rug pulls. **For protocols**, it is distribution — once Aegis owns the SEA retail relationship, every new DeFi product wants to be the next plugged-in Capability, not the next standalone app fighting for installs.

---

## Business model

### Primary: Protocol fee on execution

Every swap, send, yield deposit, stock purchase, and prediction market position settled through Aegis carries a small protocol fee, abstracted into the transaction. Invisible to the user, scales linearly with volume.

### Secondary: Platform fees from integrated protocols

The Capability system is open. Lending protocols, DEXs, asset issuers, and prediction markets pay for placement and integration — analogous to how aggregators charge for routing priority, or how Shopify charges app developers for marketplace presence. This is where the long-term margin lives.

### Tertiary: Premium features

- **Aegis Guard** — customizable per-token spending limits and advanced controls
- **Loyalty Season passes** — point multipliers and tiered rewards
- **Developer tools** — custom HTTP tool registration for protocols and enterprises

---

## Traction & current state

**The product is live and fully functional on Avalanche mainnet.**

- Non-custodial send, swap (cross-chain via Relay), and yield deposit/withdraw on Aave v3 are production-ready
- Loyalty Season 0 is seeded and active — daily on-chain activity is being rewarded
- Cloud Run backend handles real user sessions with structured observability (pino logs, Prometheus-compatible metrics, Neon Postgres, Upstash Redis)
- Telegram bot and Mini App are integrated end-to-end: auth via Privy, session key delegation, signing, confirmation, and failure recovery (including auto-prompt to top up via MoonPay on insufficient balance)
- Tokenized US stocks (via Aster) and prediction markets (via Kalshi) are the next two Capabilities, slotting into the same architecture without requiring a redesign

The architecture was built from day one as a hexagonal, plugin-style platform. Adding a new protocol is a Capability, not a refactor.

---

## Why now

- **Account abstraction reached production maturity in 2023–2024.** ZeroDev and Pimlico hardened the infrastructure. Building on ERC-4337 today is like building on AWS in 2008.
- **OpenAI's function-calling API made intent parsing trustworthy with real money.** The NL → structured JSON pipeline is reliable enough to ship.
- **Telegram Mini Apps hit an inflection point in SEA.** Native payments, TON integration, and 800M+ global daily users — heavily concentrated in our target region.
- **Tokenized US equities are accessible on-chain for the first time.** Aster and similar issuers opened up an asset class that was effectively walled off from non-US retail.
- **Regulatory clarity is improving in key SEA markets.** Vietnam, Thailand, and the Philippines have all signaled clearer frameworks for retail crypto products in the past 18 months.

---

## Roadmap

### Now (Avalanche mainnet, SEA launch)

- Send, swap (cross-chain via Relay), yield (Aave v3 USDC)
- Loyalty Season 0
- Non-custodial execution via ZeroDev session keys
- Daily yield reports and idle-fund nudges
- P2P recipient notifications via Telegram

### Next (6 months)

- **Tokenized US stocks via Aster** — Tesla, Nvidia, S&P, accessible from any SEA Telegram account
- **Prediction markets via Kalshi** — Fed decisions, elections, sports, all from chat
- **Daily intelligence engine v2** — personalized portfolio reports with risk callouts and one-tap actions
- Multi-chain expansion (Base, Arbitrum, Polygon) — chain config already abstracted
- Additional yield protocols (Benqi, Yearn) — adapter interface is pluggable
- Onramp via MoonPay webhook — buy → watch deposit → auto-invest

### Later (12 months)

- Geographic expansion beyond SEA (LatAm, MENA share the same structural gap)
- Capability marketplace — third-party protocols ship plugins without our involvement
- Institutional Aegis Guard — treasury management for DAOs and funds
- Referral program with on-chain reward distribution

---

## Team

Built by founders who have shipped production DeFi infrastructure and understand both the technical depth (hexagonal architecture, ERC-4337, cross-chain execution) and the consumer challenge (Telegram-native UX, non-technical users, trust-first design in a market burned by custodial failures).

---

## Ask

We are raising a **pre-seed round** to:

1. Hire 2 engineers and 1 growth lead for the SEA launch
2. Cover Aster and Kalshi integration costs and launch ecosystem partnerships
3. Fund user acquisition through Vietnamese and Filipino crypto communities and Telegram channels
4. Scale infrastructure to 10x current capacity ahead of the launch wave

The architecture is built to scale. The wedge is daily intelligence. The beachhead is Southeast Asia. The endgame is the platform every on-chain protocol plugs into to reach retail.

The timing is now.

---

_Aegis — own your keys, not your complexity._
