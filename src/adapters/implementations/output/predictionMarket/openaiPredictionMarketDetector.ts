import { createHash } from "crypto";
import OpenAI from "openai";
import type { RedisResponseCache } from "../../../../helpers/cache/redisResponseCache";
import { openaiLimiter } from "../../../../helpers/concurrency/openaiLimiter";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  DetectorInput,
  IPredictionMarketDetector,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketDetector";
import type {
  DraftFinding,
  FindingConfidence,
  FindingPatternType,
} from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("predictionMarketDetector");

const PATTERN_TYPES: FindingPatternType[] = [
  "logical_inconsistency",
  "term_structure_anomaly",
  "implied_contradiction",
  "movement_divergence",
  "other",
];

const CONFIDENCE_VALUES: FindingConfidence[] = ["low", "medium", "high"];

const SYSTEM_PROMPT = `You are reviewing a CLUSTER of related prediction-market questions priced on Polymarket. Stage 2 already established that these markets share a single causal driver and articulated the expected relationship between them. Your job in stage 3 is to check whether the ACTUAL prices match that expectation, and to surface any mispricing patterns you spot.

You look for FOUR specific patterns:

1. logical_inconsistency — the cluster's prices violate a logical inequality. Example: "Fed cuts ≥25bps" trades at 55¢ while "Fed cuts ≥50bps" trades at 60¢. The wider event must be priced ≥ the narrower event; here it is not.

2. term_structure_anomaly — the same question at different horizons is priced incoherently. Example: "BTC > $100k by Q1" at 30¢, "by Q2" at 25¢, "by Q3" at 28¢. Term structure should be monotonically non-decreasing for "by-date" framings.

3. implied_contradiction — the prices imply scenarios that cannot all coexist. Example: a sports cluster prices "Team A wins championship" at 40¢, "Team A makes finals" at 30¢ — making finals is a precondition of winning, the implied conditional is broken.

4. movement_divergence — markets that should co-move with the same underlying driver are moving in opposite directions, or one has clearly lagged. Example: two Fed-rate-path markets that historically co-move; one moved +300bps in the last 24h while the other is flat. The lagger may be slow.

Important guardrails:
- It is COMPLETELY NORMAL for a cluster to have NO findings. Most clusters are priced sensibly. If you cannot identify a clean instance of one of the four patterns, return {"findings": []}. Do NOT force a finding.
- Resolution-criteria differences can mask apparent inconsistencies — read the criteria, two markets may not actually be the same proposition. If the criteria differ in a way that explains the gap, do not flag it.
- Volume/liquidity matters — a 200-bp gap on a $5k market is usually noise, not signal. Prefer findings that involve markets the cluster lists with non-trivial trading.
- Movement-divergence findings can be stale; only flag when the gap is meaningful (>1pp) and recent.
- Each finding involves exactly TWO sides (sideA, sideB) — the two trades a reader would put on if they believed your thesis. label ≤60 chars; rationale ≤200 chars.

CRITICAL — DO NOT confuse consensus with contradiction.
A mutually-exclusive cluster (e.g. Fed June meeting outcomes — "no change", "+25bp cut", "+50bp hike") whose YES probabilities sum to ≈100% is CORRECTLY priced, regardless of how lopsided the individual prices look. 96% no-change + 3% cut + 0% hike = 99% sum is a market in tight CONSENSUS, NOT a contradiction. Do not flag this as implied_contradiction. The "Stage-2 expected relationships" payload tells you whether a cluster is mutually_exclusive — use it. A mutually-exclusive cluster only has an implied_contradiction when the YES prices DO NOT sum to ~100% (e.g. they sum to 130% — overpriced, an arbitrage; or 70% — underpriced).

Confidence calibration (apply this scale strictly):
- HIGH: a textbook example of one of the four patterns, with no plausible alternative explanation. Sum-of-probabilities is far from 100% on a mutually-exclusive set; nested events priced strictly upside-down; a clearly stale lagging market with a fresh news catalyst on its sibling. If a thoughtful trader would look at this and say "yes, that's broken" without hesitation — HIGH.
- MEDIUM: the pattern is plausible but not airtight. Resolution criteria might explain it; the gap could be liquidity noise; the divergence might be the leader overreacting rather than the lagger being slow.
- LOW: you noticed something that looks off, but you'd want more data. Most "low" findings should actually be returned as no finding at all — when in doubt, omit.

Schema discipline:
- Write \`rationale\` BEFORE \`sideA\`/\`sideB\` — you must reason first.
- \`pattern_type\` ∈ ${JSON.stringify(PATTERN_TYPES)}.
- \`markets_involved\` MUST be a strict subset of the cluster's market_ids (no hallucinated ids).
- \`confidence\` reflects how cleanly the pattern fits — high = textbook example; medium = plausible but not airtight; low = noisy.

If nothing is anomalous, return {"findings": []}.`;

interface DetectorJsonResponse {
  findings: Array<{
    pattern_type: FindingPatternType;
    rationale: string;
    why_anomalous: string;
    markets_involved: string[];
    current_state: {
      // OpenAI strict-mode forbids `additionalProperties: <schema>` (open
      // string-keyed maps), so we transport this as an array of pairs and
      // re-shape into a Record on parse.
      cited_odds: Array<{ market_id: string; yes_price: number }>;
    };
    side_a: { label: string; market_id: string; outcome: "YES" | "NO"; rationale: string };
    side_b: { label: string; market_id: string; outcome: "YES" | "NO"; rationale: string };
    confidence: FindingConfidence;
  }>;
}

const FINDING_SCHEMA = {
  name: "prediction_market_findings",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "pattern_type",
            "rationale",
            "why_anomalous",
            "markets_involved",
            "current_state",
            "side_a",
            "side_b",
            "confidence",
          ],
          properties: {
            pattern_type: { type: "string", enum: PATTERN_TYPES },
            rationale: { type: "string" },
            why_anomalous: { type: "string" },
            markets_involved: { type: "array", items: { type: "string" } },
            current_state: {
              type: "object",
              additionalProperties: false,
              required: ["cited_odds"],
              properties: {
                cited_odds: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["market_id", "yes_price"],
                    properties: {
                      market_id: { type: "string" },
                      yes_price: { type: "number" },
                    },
                  },
                },
              },
            },
            side_a: {
              type: "object",
              additionalProperties: false,
              required: ["label", "market_id", "outcome", "rationale"],
              properties: {
                label: { type: "string" },
                market_id: { type: "string" },
                outcome: { type: "string", enum: ["YES", "NO"] },
                rationale: { type: "string" },
              },
            },
            side_b: {
              type: "object",
              additionalProperties: false,
              required: ["label", "market_id", "outcome", "rationale"],
              properties: {
                label: { type: "string" },
                market_id: { type: "string" },
                outcome: { type: "string", enum: ["YES", "NO"] },
                rationale: { type: "string" },
              },
            },
            confidence: { type: "string", enum: CONFIDENCE_VALUES },
          },
        },
      },
    },
  },
} as const;

export interface OpenAIPredictionMarketDetectorConfig {
  apiKey: string;
  model: string;
  cache?: RedisResponseCache;
  promptVersion: string;
  cacheTtlSec: number;
  /** Round member YES prices to this bp bucket when keying the cache. */
  priceBucketBps: number;
}

function bucketPriceBp(priceFraction: number, bucketBps: number): number {
  const bp = Math.max(0, Math.min(10_000, Math.round(priceFraction * 10_000)));
  if (bucketBps <= 0) return bp;
  return Math.round(bp / bucketBps) * bucketBps;
}

export class OpenAIPredictionMarketDetector implements IPredictionMarketDetector {
  private readonly client: OpenAI;

  constructor(private readonly cfg: OpenAIPredictionMarketDetectorConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey });
  }

  private cacheKey(input: DetectorInput): string {
    const bucket = this.cfg.priceBucketBps;
    const memberPart = [...input.members]
      .sort((a, b) => a.marketId.localeCompare(b.marketId))
      .map((m) => `${m.marketId}@${bucketPriceBp(m.yesPrice, bucket)}`)
      .join("|");
    const raw = `${input.cluster.clusterId}::${memberPart}::${this.cfg.promptVersion}::${this.cfg.model}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  async detect(input: DetectorInput): Promise<DraftFinding[]> {
    const { reqId, cluster, members } = input;
    const start = Date.now();
    log.info(
      { step: "started", reqId, clusterId: cluster.clusterId, members: members.length },
      "detect",
    );

    if (members.length < 2) {
      log.info(
        { step: "succeeded", reqId, clusterId: cluster.clusterId, drafts: 0, durationMs: Date.now() - start, mode: "too-few-members" },
        "detect",
      );
      return [];
    }

    const key = this.cacheKey(input);
    if (this.cfg.cache) {
      const hit = await this.cfg.cache.get<DraftFinding[]>(key);
      log.debug({ choice: hit ? "hit" : "miss", reqId, clusterId: cluster.clusterId }, "detect cache lookup");
      if (hit) {
        log.info(
          { step: "succeeded", reqId, clusterId: cluster.clusterId, drafts: hit.length, durationMs: Date.now() - start, mode: "cache" },
          "detect",
        );
        return hit;
      }
    }

    const memberRecords = members.map((m) => ({
      marketId: m.marketId,
      question: m.question,
      yesPrice: m.yesPrice,
      noPrice: m.noPrice,
      liquidityUsd: m.liquidityUsd,
      volume7dUsd: m.volume7dUsd,
      resolutionDate: new Date(m.resolutionEpochSec * 1000).toISOString().slice(0, 10),
      priceChange24hBps: m.priceChange24hBps ?? null,
      priceChange7dBps: m.priceChange7dBps ?? null,
    }));

    const userMessage =
      `Cluster theme: ${cluster.theme}\n` +
      `Causal driver: ${cluster.causalDriver}\n` +
      `Stage-2 expected relationships:\n${JSON.stringify(cluster.expectedRelationships, null, 2)}\n\n` +
      `Members (current snapshot):\n` +
      "```json\n" +
      JSON.stringify(memberRecords, null, 2) +
      "\n```\n\n" +
      `Identify any of the four mispricing patterns. Empty findings array is acceptable.`;

    let parsed: DetectorJsonResponse | null = null;
    let raw = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const completion = await openaiLimiter(() =>
          this.client.chat.completions.create({
            model: this.cfg.model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage },
              ...(attempt === 2
                ? [
                    {
                      role: "user" as const,
                      content:
                        "Your previous output was not valid JSON for the schema. Retry, returning ONLY the JSON object.",
                    },
                  ]
                : []),
            ],
            response_format: { type: "json_schema", json_schema: FINDING_SCHEMA },
          }),
        );
        raw = completion.choices[0]?.message?.content ?? "";
        parsed = JSON.parse(raw) as DetectorJsonResponse;
        break;
      } catch (err) {
        log.warn({ reqId, clusterId: cluster.clusterId, attempt, err }, "detect parse/call failed");
        parsed = null;
      }
    }

    if (!parsed) {
      log.error({ reqId, clusterId: cluster.clusterId, raw: raw.slice(0, 200) }, "detect failed");
      return [];
    }

    const knownIds = new Set(cluster.marketIds);

    const drafts: DraftFinding[] = [];
    for (const f of parsed.findings) {
      const involved = f.markets_involved.filter((id) => {
        if (knownIds.has(id)) return true;
        log.warn({ reqId, clusterId: cluster.clusterId, droppedHallucination: id }, "detect post-parse drop");
        return false;
      });
      if (involved.length < 2) continue;
      if (!knownIds.has(f.side_a.market_id) || !knownIds.has(f.side_b.market_id)) {
        log.warn(
          { reqId, clusterId: cluster.clusterId, droppedHallucination: `${f.side_a.market_id}|${f.side_b.market_id}` },
          "detect post-parse drop side hallucination",
        );
        continue;
      }
      const citedOdds: Record<string, number> = {};
      for (const { market_id, yes_price } of f.current_state.cited_odds) {
        citedOdds[market_id] = yes_price;
      }
      drafts.push({
        patternType: f.pattern_type,
        marketsInvolved: involved,
        currentState: { citedOdds },
        whyAnomalous: f.why_anomalous,
        sideA: {
          label: f.side_a.label,
          marketId: f.side_a.market_id,
          outcome: f.side_a.outcome,
          rationale: f.side_a.rationale,
        },
        sideB: {
          label: f.side_b.label,
          marketId: f.side_b.market_id,
          outcome: f.side_b.outcome,
          rationale: f.side_b.rationale,
        },
        confidence: f.confidence,
        rationale: f.rationale,
      });
    }

    if (this.cfg.cache) {
      await this.cfg.cache.set(key, drafts, this.cfg.cacheTtlSec);
    }

    log.info(
      { step: "succeeded", reqId, clusterId: cluster.clusterId, drafts: drafts.length, durationMs: Date.now() - start, mode: "fresh" },
      "detect",
    );
    return drafts;
  }
}
