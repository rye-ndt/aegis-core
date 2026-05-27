import { createHash } from "crypto";
import OpenAI from "openai";
import {
  callJsonSchemaWithRetry,
  createOpenRouterClient,
  type ReasoningEffort,
} from "../../../../helpers/llm/openrouterClient";
import type { RedisResponseCache } from "../../../../helpers/cache/redisResponseCache";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  ClassifierInput,
  IPredictionMarketClassifier,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketClassifier";
import type {
  ClusterConfidence,
  DraftCluster,
  ExpectedRelationshipKind,
} from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";

const log = createLogger("predictionMarketClassifier");

const RELATIONSHIP_KINDS: ExpectedRelationshipKind[] = [
  "mutually_exclusive",
  "nested",
  "term_structure",
  "co_moving",
  "other",
];

const CONFIDENCE_VALUES: ClusterConfidence[] = ["low", "medium", "high"];

const SYSTEM_PROMPT = `You group prediction-market questions into "causal clusters".

A coherent cluster is one where THE SAME REAL-WORLD EVENT materially affects how every market in the cluster resolves. Topical overlap is NOT enough. Two questions both being "about Trump" or "about crypto" is NOT a cluster — they must share a causal driver such that learning the outcome of one shifts your belief about the others through the same mechanism.

For each cluster you must:
- Pick a single shared causal driver in plain English (e.g. "FOMC March-2026 rate decision", "outcome of the 2026 US presidential election", "whether Bitcoin closes above $100k by year end").
- Choose ONE relationship kind for how the markets relate:
  - mutually_exclusive: at most one resolves YES (e.g. "candidate X wins" / "candidate Y wins")
  - nested: one market's resolution implies another's (e.g. "Fed cuts ≥25bps" implies "Fed does not hike")
  - term_structure: same question at different horizons (e.g. "BTC > $100k by Q1" / "by Q2" / "by Q3")
  - co_moving: same driver moves them in the same direction without strict logical dependence
  - other: explain in description if none fit
- Provide a one-sentence rationale BEFORE listing market_ids, so you reason first.
- Each cluster must contain ≥3 market_ids.
- Each market_id appears in AT MOST ONE cluster across the whole output.
- Confidence: high = clear causal mechanism + tightly coupled resolutions; medium = plausible but loose; low = speculative.

Examples of GOOD clusters (causal):
- "Fed March-2026 rate decision" linking "Fed cuts 25bps in March", "Fed cuts 50bps in March", "Fed holds in March" (mutually_exclusive).
- "2026 US presidential general election outcome" linking "Candidate A wins", "Republicans win presidency", "Democrats win presidency" (nested + mutually_exclusive — pick the dominant one).
- "Whether the Chiefs win Super Bowl LX" linking "Chiefs win SB", "Mahomes named SB MVP", "AFC wins SB" (nested/co_moving).

Examples of BAD clusters (REJECT):
- "Markets about Trump" — topical, not causal.
- "Markets about crypto" — topical, no shared event.
- Two markets that share keywords but resolve from different sources/dates with no shared driver.

If nothing coherent exists, return {"clusters": []}. Empty output is acceptable and preferred over forcing weak clusters.`;

interface ClassifierJsonResponse {
  clusters: Array<{
    theme: string;
    causal_driver: string;
    rationale: string;
    market_ids: string[];
    expected_relationships: Array<{
      kind: ExpectedRelationshipKind;
      description: string;
    }>;
    confidence: ClusterConfidence;
  }>;
}

const CLUSTER_SCHEMA = {
  name: "prediction_market_clusters",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["clusters"],
    properties: {
      clusters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "theme",
            "causal_driver",
            "rationale",
            "market_ids",
            "expected_relationships",
            "confidence",
          ],
          properties: {
            theme: { type: "string" },
            causal_driver: { type: "string" },
            rationale: { type: "string" },
            // OpenAI strict-mode JSON schema rejects `minItems`/`maxItems`;
            // the ≥3 floor is enforced in post-parse cleanup below.
            market_ids: {
              type: "array",
              items: { type: "string" },
            },
            expected_relationships: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "description"],
                properties: {
                  kind: { type: "string", enum: RELATIONSHIP_KINDS },
                  description: { type: "string" },
                },
              },
            },
            confidence: { type: "string", enum: CONFIDENCE_VALUES },
          },
        },
      },
    },
  },
} as const;

function cacheKey(args: {
  marketIds: string[];
  promptVersion: string;
  model: string;
}): string {
  // 2026-05-20 LLM-cost reduction (Phase A3): resolution epoch dropped from
  // the key. Polymarket resolution dates almost never shift, and including
  // them forced a miss on every expiry. Worst case (a moved resolution
  // date) we serve a stale cluster for up to clusterCacheTtlSec (24h);
  // upstream reclusterDelta / maxReclusterAgeMs still trigger refresh on
  // universe drift.
  const sorted = [...args.marketIds].sort().join("|");
  const h = createHash("sha256").update(sorted).digest("hex");
  return `${args.promptVersion}:${args.model}:${h}`;
}

function dedupeOverlap(clusters: DraftCluster[], reqId: string): DraftCluster[] {
  const confidenceRank: Record<ClusterConfidence, number> = { low: 0, medium: 1, high: 2 };
  const ordered = [...clusters].sort(
    (a, b) => confidenceRank[b.confidence] - confidenceRank[a.confidence],
  );
  const taken = new Set<string>();
  const kept: DraftCluster[] = [];
  for (const c of ordered) {
    const overlap = c.marketIds.find((id) => taken.has(id));
    if (overlap !== undefined) {
      log.warn({ reqId, droppedDup: overlap, theme: c.theme }, "classify dedup-overlap");
      continue;
    }
    for (const id of c.marketIds) taken.add(id);
    kept.push(c);
  }
  return kept;
}

export interface OpenRouterPredictionMarketClassifierConfig {
  model: string;
  cache?: RedisResponseCache;
  maxCriteriaChars: number;
  promptVersion: string;
  cacheTtlSec: number;
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
}

export class OpenRouterPredictionMarketClassifier implements IPredictionMarketClassifier {
  private readonly client: OpenAI;

  constructor(private readonly cfg: OpenRouterPredictionMarketClassifierConfig) {
    this.client = createOpenRouterClient();
  }

  async classify(input: ClassifierInput): Promise<DraftCluster[]> {
    const { reqId, markets } = input;
    const start = Date.now();
    log.info({ step: "started", reqId, marketCount: markets.length }, "classify");

    if (markets.length < 3) {
      log.info({ step: "succeeded", reqId, clusters: 0, durationMs: Date.now() - start, mode: "too-few-markets" }, "classify");
      return [];
    }

    const key = cacheKey({
      marketIds: markets.map((m) => m.marketId),
      promptVersion: this.cfg.promptVersion,
      model: this.cfg.model,
    });

    if (this.cfg.cache) {
      const hit = await this.cfg.cache.get<DraftCluster[]>(key);
      log.debug({ choice: hit ? "hit" : "miss", reqId }, "cluster cache lookup");
      if (hit) {
        log.info(
          { step: "succeeded", reqId, clusters: hit.length, durationMs: Date.now() - start, mode: "cache" },
          "classify",
        );
        return hit;
      }
    }

    const records = markets.map((m) => {
      let criteria = m.resolutionCriteria;
      if (criteria.length > this.cfg.maxCriteriaChars) {
        log.warn(
          { reqId, marketId: m.marketId, originalLen: criteria.length, cap: this.cfg.maxCriteriaChars },
          "criteria truncated — raise PREDICTION_MARKETS_MAX_CRITERIA_CHARS if this fires often",
        );
        criteria = criteria.slice(0, this.cfg.maxCriteriaChars);
      }
      return {
        marketId: m.marketId,
        question: m.question,
        resolutionCriteria: criteria,
        resolutionDate: new Date(m.resolutionEpochSec * 1000).toISOString().slice(0, 10),
        categoryHint: m.category,
      };
    });

    const userMessage =
      "Cluster the following prediction markets by shared causal driver. " +
      "Return JSON conforming to the schema. " +
      "Markets:\n```json\n" +
      JSON.stringify(records, null, 2) +
      "\n```";

    const { parsed, raw } = await callJsonSchemaWithRetry<ClassifierJsonResponse>({
      client: this.client,
      model: this.cfg.model,
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      jsonSchema: { type: "json_schema", json_schema: CLUSTER_SCHEMA },
      // Defaults + restore knobs documented at the env source
      // (PREDICTION_MARKETS_CLASSIFIER_REASONING_EFFORT / _MAX_TOKENS in
      // predictionMarketEnv.ts).
      maxTokens: this.cfg.maxTokens,
      reasoningEffort: this.cfg.reasoningEffort,
      logCtx: { reqId, op: "classify" },
    });

    if (!parsed) {
      log.error({ reqId, raw: raw.slice(0, 200) }, "classify failed");
      return [];
    }

    const draft: DraftCluster[] = parsed.clusters
      .filter((c) => c.market_ids.length >= 3)
      .map((c) => ({
        theme: c.theme,
        causalDriver: c.causal_driver,
        marketIds: c.market_ids,
        expectedRelationships: c.expected_relationships.map((r) => ({
          kind: r.kind,
          description: r.description,
        })),
        rationale: c.rationale,
        confidence: c.confidence,
      }));

    // Drop unknown market_ids the model might hallucinate.
    const known = new Set(markets.map((m) => m.marketId));
    const cleaned = draft
      .map((c) => ({ ...c, marketIds: c.marketIds.filter((id) => known.has(id)) }))
      .filter((c) => c.marketIds.length >= 3);

    const deduped = dedupeOverlap(cleaned, reqId);

    if (this.cfg.cache) {
      await this.cfg.cache.set(key, deduped, this.cfg.cacheTtlSec);
    }

    log.info(
      { step: "succeeded", reqId, clusters: deduped.length, durationMs: Date.now() - start, mode: "fresh" },
      "classify",
    );
    return deduped;
  }
}
