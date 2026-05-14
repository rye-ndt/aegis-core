import OpenAI from "openai";
import {
  callJsonSchemaWithRetry,
  createOpenRouterClient,
} from "../../../../helpers/llm/openrouterClient";
import { createLogger } from "../../../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type {
  ExtractorInput,
  ExtractorOutcome,
  IPredictionMarketExtractor,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketExtractor";
import {
  canonicalEventFamily,
  type MarketFact,
  type Operator,
  type ResolutionMethod,
  type ThresholdUnit,
} from "../../../../use-cases/interface/predictionMarket/MarketFactTypes";
import {
  RESOLUTION_SOURCES,
  SUBJECTS,
  type ResolutionSourceCode,
  type SubjectCode,
} from "../../../../use-cases/interface/predictionMarket/marketFactVocabularies";
import { verifyFact } from "./marketFactRegexVerifier";

const log = createLogger("predictionMarketExtractor");

const OPERATORS: Operator[] = ["gte", "lte", "gt", "lt", "eq", "in"];
const THRESHOLD_UNITS: ThresholdUnit[] = ["USD", "USD_PCT", "BPS", "COUNT", "BOOL", "CATEGORY"];
const RESOLUTION_METHODS: ResolutionMethod[] = [
  "any_touch_during_window",
  "close_at_window_end",
  "twap_during_window",
  "official_announcement",
  "uma_optimistic_oracle",
  "discrete_outcome_announcement",
];

const SYSTEM_PROMPT = `You convert ONE prediction market into a structured fact. The set of allowed \`subject\` and \`resolution_source\` values is FIXED — pick from the enum or output \`OTHER\` and explain in \`extraction_notes\`. \`OTHER\` is the sentinel — use it freely when the market doesn't fit; downstream code forces those to human review.

Reason about the title AND the resolution criteria together; the title alone is usually ambiguous about the window or threshold unit. Do NOT invent thresholds — if a number isn't stated explicitly in the title or criteria, leave \`threshold_numeric\` / \`threshold_string\` / \`threshold_set\` null and mark this in \`extraction_notes\`.

Threshold fields are split for strict-schema reasons:
- Numeric threshold → set \`threshold_numeric\`, leave the others null.
- Single category / freeform string threshold → set \`threshold_string\`, leave numeric/set null.
- For \`operator: 'in'\` (set membership), populate \`threshold_set\` with each allowed value; leave numeric/string null.

Window times are epoch seconds, UTC. \`window_end\` MUST equal the market's stated resolution date within ±24h. \`window_start\` is null unless the criteria explicitly bounds the start of an observation window ("between … and …", "during May 2026", etc.).

Pick the most specific \`resolution_source\` you can defend from the criteria. Crypto spot prices are pairwise INCOMPATIBLE — if the criteria names Coinbase, do not output COINGECKO_TWAP_1H even if it would also work. If you can't tell, output \`OTHER\` so a human can resolve it.`;

interface ExtractorJsonResponse {
  subject: SubjectCode;
  operator: Operator;
  threshold_numeric: number | null;
  threshold_string: string | null;
  threshold_set: string[] | null;
  threshold_unit: ThresholdUnit;
  window_start: number | null;
  window_end: number;
  resolution_source: ResolutionSourceCode;
  resolution_method: ResolutionMethod;
  polymarket_event_id: string | null;
  extraction_notes: string;
}

const EXTRACTOR_SCHEMA = {
  name: "prediction_market_fact",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "subject",
      "operator",
      "threshold_numeric",
      "threshold_string",
      "threshold_set",
      "threshold_unit",
      "window_start",
      "window_end",
      "resolution_source",
      "resolution_method",
      "polymarket_event_id",
      "extraction_notes",
    ],
    properties: {
      subject: { type: "string", enum: SUBJECTS },
      operator: { type: "string", enum: OPERATORS },
      threshold_numeric: { type: ["number", "null"] },
      threshold_string: { type: ["string", "null"] },
      threshold_set: {
        type: ["array", "null"],
        items: { type: "string" },
      },
      threshold_unit: { type: "string", enum: THRESHOLD_UNITS },
      window_start: { type: ["integer", "null"] },
      window_end: { type: "integer" },
      resolution_source: { type: "string", enum: RESOLUTION_SOURCES },
      resolution_method: { type: "string", enum: RESOLUTION_METHODS },
      polymarket_event_id: { type: ["string", "null"] },
      extraction_notes: { type: "string" },
    },
  },
} as const;

export interface OpenAIPredictionMarketExtractorConfig {
  model: string;
  promptVersion: string;
}

export class OpenAIPredictionMarketExtractor implements IPredictionMarketExtractor {
  private readonly client: OpenAI;

  constructor(private readonly cfg: OpenAIPredictionMarketExtractorConfig) {
    this.client = createOpenRouterClient();
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutcome> {
    const { reqId, market } = input;
    const start = Date.now();
    log.info(
      { step: "extract-fact-start", reqId, marketId: market.marketId, subject: "?" },
      "extract",
    );

    const userMessage =
      `Title: ${market.question}\n\n` +
      `Resolution criteria:\n${market.resolutionCriteria}\n\n` +
      `Stated resolution time (epoch sec, UTC): ${market.resolutionEpochSec}\n` +
      `Category hint: ${market.category ?? "<none>"}\n` +
      `Polymarket event id (if any): ${market.polymarketEventId ?? "<none>"}\n\n` +
      `Allowed subjects: ${JSON.stringify(SUBJECTS)}\n` +
      `Allowed resolution sources: ${JSON.stringify(RESOLUTION_SOURCES)}`;

    const { parsed, raw } = await callJsonSchemaWithRetry<ExtractorJsonResponse>({
      client: this.client,
      model: this.cfg.model,
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      jsonSchema: { type: "json_schema", json_schema: EXTRACTOR_SCHEMA },
      // Single MarketFact — small JSON, but `subject` / `resolution_source`
      // classification has real subtleties (e.g. distinguishing Coinbase vs
      // CoinGecko-TWAP from criteria phrasing). The regex verifier catches
      // shape errors, not semantic mispicks — so we spend medium reasoning
      // for better category selection. 8k leaves headroom after reasoning.
      maxTokens: 8000,
      reasoningEffort: "medium",
      logCtx: { reqId, marketId: market.marketId, op: "extract" },
    });

    if (!parsed) {
      log.error({ reqId, marketId: market.marketId, raw: raw.slice(0, 200) }, "extract failed");
      return { kind: "failed", reason: "llm-parse-failed" };
    }

    const threshold = pickScalarThreshold(parsed, parsed.operator);
    const proposed: MarketFact = {
      marketId: market.marketId,
      subject: parsed.subject,
      operator: parsed.operator,
      threshold,
      thresholdSet: parsed.operator === "in" ? parsed.threshold_set : null,
      thresholdUnit: parsed.threshold_unit,
      windowStart: parsed.window_start,
      windowEnd: parsed.window_end,
      resolutionSource: parsed.resolution_source,
      resolutionMethod: parsed.resolution_method,
      eventFamily: canonicalEventFamily({
        subject: parsed.subject,
        windowStart: parsed.window_start,
        windowEnd: parsed.window_end,
        resolutionSource: parsed.resolution_source,
      }),
      polymarketEventId: parsed.polymarket_event_id ?? market.polymarketEventId ?? null,
      extractionModel: this.cfg.model,
      extractionPromptVersion: this.cfg.promptVersion,
      extractionAtEpoch: newCurrentUTCEpoch(),
      regexVerified: false,
    };

    const result = verifyFact({ market, proposed });
    const durationMs = Date.now() - start;
    if (result.ok) {
      const fact: MarketFact = { ...proposed, regexVerified: true };
      log.info(
        {
          step: "extract-fact-end",
          reqId,
          marketId: market.marketId,
          subject: fact.subject,
          eventFamily: fact.eventFamily,
          outcome: "verified",
          regexVerified: true,
          durationMs,
        },
        "extract",
      );
      return { kind: "verified", fact };
    }
    log.warn(
      {
        step: "extract-fact-end",
        reqId,
        marketId: market.marketId,
        subject: proposed.subject,
        outcome: "review",
        regexVerified: false,
        failures: result.failures.map((f) => f.field),
        durationMs,
      },
      "extract",
    );
    return { kind: "review", proposedFact: proposed, regexFailures: result.failures };
  }
}

function pickScalarThreshold(
  parsed: ExtractorJsonResponse,
  operator: Operator,
): number | string | null {
  if (operator === "in") return null;
  if (parsed.threshold_numeric !== null) return parsed.threshold_numeric;
  if (parsed.threshold_string !== null) return parsed.threshold_string;
  return null;
}
