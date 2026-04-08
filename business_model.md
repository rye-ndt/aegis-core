# Business Model - Aegis

## Problem

Every AI company doing RLHF faces the same bottleneck: the dataset. Existing data pipelines rely on crowdsourced annotation platforms (Scale AI, Appen, Surge) that produce labeled data in controlled, artificial settings. The result is data that is clean on the surface but contextually thin - it does not capture how real users actually interact with an AI assistant over time, what corrections they make, what they tolerate, what they come back for. This gap limits the quality ceiling for fine-tuned and aligned models.

There is no market today for high-quality, consented, provenance-verified, real-world interaction data at scale.

---

## Solution

Aegis is a personal AI assistant - available as a Telegram bot today, with a physical form factor on the roadmap - that generates curated interaction data as a natural byproduct of daily use.

Every turn of a conversation produces a structured record: the agent's action, the user's implicit or explicit feedback signal, and the surrounding context. After a session, users can review these records and choose which ones to contribute to the Aegis dataset. Each contribution is anchored on-chain (Avalanche), giving it a verifiable timestamp and provenance hash. The user receives AGS tokens as a reward. The dataset grows.

AI labs, research teams, and companies that want access to this dataset pay AGS tokens to query it. Aegis takes a protocol fee on every data purchase.

---

## Value Propositions

**For users (data contributors):**

- A genuinely useful personal assistant (calendar, tasks, memory, web search, voice) at no direct cost.
- Earn AGS tokens for contributing interaction records they already generate.
- Full control: users select what they share; nothing is contributed without explicit opt-in.
- Seamless onboarding: an ERC-4337 smart account is provisioned automatically on registration, no wallet setup required.

**For data buyers (AI labs, fine-tuning shops, researchers):**

- Real-world, longitudinal interaction data - not synthetic, not crowdsourced in isolation.
- Each record includes: agent action, tool calls, reasoning trace, feedback signal (implicit correction / explicit rating), conversation context, and on-chain provenance.
- Pay-per-query or bulk access via AGS tokens.

---

## Token: AGS (Aegis)

- **Utility token** on Avalanche (Fuji testnet → mainnet).
- **Earn:** Contributed and accepted data records → AGS minted by RewardController.
- **Spend:** Purchase access to the dataset.
- **Supply control:** RewardController enforces a per-user daily cap (5 contributions/day) to limit inflation; fraud-resistance mechanisms to follow.
- Smart accounts (ERC-4337) receive tokens automatically - no manual claiming UX needed.

---

## Go-to-Market

**Phase 1 - Assistant product (now):** Telegram bot live. Users interact, feedback is captured silently. Goal: build a base of active users generating raw evaluation logs.

**Phase 2 - Contribution layer (next):** Expose the `/contribute` flow. Users review their records, opt-in to share, earn AGS. First dataset batches published.

**Phase 3 - Data marketplace:** Open dataset access to paying buyers. First customers are small AI labs and independent researchers; expand to enterprise fine-tuning teams.

**Phase 4 - Scale + hardware:** Physical form factor expands use cases (ambient assistant, voice-first). More diverse interaction modalities → richer, more valuable dataset.

---

## Revenue Model

| Stream                     | Mechanism                                                                       |
| -------------------------- | ------------------------------------------------------------------------------- |
| Dataset access fees        | Buyers pay AGS to access records; protocol takes a percentage                   |
| Premium assistant features | Optional subscription for power users (longer memory, priority models)          |
| Ecosystem grants           | Avalanche Foundation, AI research foundations funding early data infrastructure |

---

## Competitive Moat

- **Consent + provenance by design.** Every record is user-consented and hashed on-chain. As data regulation tightens (EU AI Act, US frameworks), this is not a nice-to-have.
- **Longitudinal depth.** A single user's records span weeks or months of real interactions, not isolated annotation tasks.
- **Flywheel.** More users → more data → more valuable dataset → more buyers → more AGS demand → stronger incentive to contribute → more users.
- **Network effect on the model side.** A model fine-tuned on Aegis data, released back to the ecosystem, drives more assistant adoption.

---

## Risks

- **Data quality at scale.** Early users are likely technically sophisticated; dataset may not generalize until broader user base is established.
- **Token economics.** Balancing supply (contributor rewards) against demand (buyer consumption) requires active tuning and anti-fraud mechanisms.
- **Regulatory.** Storing behavioral data, even consented, requires clear jurisdiction-specific compliance posture.
- **Competition.** Well-funded players (Anthropic, OpenAI) could build similar flywheel internally. Aegis's edge is openness and user ownership.
