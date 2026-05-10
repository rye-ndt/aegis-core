import type { Api } from "grammy";
import type Redis from "ioredis";
import pLimit from "p-limit";
import { createLogger } from "../../../../helpers/observability/logger";
import type {
  FindingBroadcastInput,
  FindingBroadcastResult,
  IPredictionMarketFindingBroadcaster,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketFindingBroadcaster";
import type {
  FindingPatternType,
  RawMarket,
  StoredCluster,
  VerifiedFinding,
} from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";
import type {
  IntentResult,
  ResultAction,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import { renderResultCard } from "../artifactRenderer/resultCard.render";

import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";

const log = createLogger("predictionMarketFindingBroadcaster");

const BROADCAST_DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;

const PATTERN_HEADLINES: Record<FindingPatternType, string> = {
  logical_inconsistency: "Logical inconsistency spotted",
  term_structure_anomaly: "Term-structure anomaly spotted",
  implied_contradiction: "Implied-scenario contradiction spotted",
  movement_divergence: "Movement divergence spotted",
  other: "Mispricing pattern spotted",
};

export interface PredictionMarketFindingBroadcasterDeps {
  tgApi: Api;
  redis: Redis;
  listActiveUserIds: () => Promise<string[]>;
  getChatId: (userId: string) => Promise<string | null>;
  concurrency: number;
  /** Optional `?affiliate=…` query string param (empty = no param). */
  affiliateParam: string;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function formatGap(magnitudeBps: number): string {
  if (magnitudeBps >= 100) return `${(magnitudeBps / 100).toFixed(1)}pp`;
  return `${magnitudeBps}bp`;
}

function polymarketUrl(market: RawMarket | undefined, affiliate: string): string {
  if (!market) return "https://polymarket.com/";
  const base = market.slug
    ? `https://polymarket.com/market/${market.slug}`
    : market.url || "https://polymarket.com/";
  if (!affiliate) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}affiliate=${encodeURIComponent(affiliate)}`;
}

function buildResult(args: {
  finding: VerifiedFinding;
  cluster: StoredCluster;
  marketById: Map<string, RawMarket>;
  affiliateParam: string;
}): IntentResult {
  const { finding, cluster, marketById, affiliateParam } = args;

  const fields: ResultField[] = [
    { label: "Cluster", value: cluster.theme, emphasis: "primary" },
    { label: "Driver", value: cluster.causalDriver },
    { label: "Gap", value: formatGap(finding.magnitudeBps), emphasis: "primary" },
    {
      label: "Confidence",
      value: finding.confidence,
      emphasis: finding.confidence === "high" ? "primary" : "muted",
    },
  ];

  const details: ResultField[] = [
    { label: "What's anomalous", value: finding.whyAnomalous },
    ...finding.marketsInvolved.map((id) => ({
      label: marketById.get(id)?.question ?? id,
      value: `YES ${pct(finding.liveOdds[id] ?? 0)}`,
    })),
    { label: `Side A — ${finding.sideA.label}`, value: finding.sideA.rationale },
    { label: `Side B — ${finding.sideB.label}`, value: finding.sideB.rationale },
  ];

  // When bet execution is enabled (stage 4), the side buttons become callbacks
  // that drop the user into the place-bet chat flow (`PlaceBetCapability`).
  // When disabled, we keep the legacy URL-out behaviour so the finding card
  // remains useful even before the bet pipeline is turned on for a deployment.
  const nextActions: ResultAction[] = PREDICTION_MARKETS_ENV.betsEnabled
    ? [
        // Telegram caps callback_data at 64 bytes — Polymarket condition_ids
        // alone are 66, so we omit the marketId from the payload and resolve it
        // server-side via the persisted finding row in PlaceBetCapability.
        {
          label: `Bet ${finding.sideA.label}`.slice(0, 60),
          kind: "callback",
          payload: `place_bet:${finding.findingId}:A`,
        },
        {
          label: `Bet ${finding.sideB.label}`.slice(0, 60),
          kind: "callback",
          payload: `place_bet:${finding.findingId}:B`,
        },
      ]
    : [
        {
          label: `Bet ${finding.sideA.label}`.slice(0, 60),
          kind: "url",
          payload: polymarketUrl(marketById.get(finding.sideA.marketId), affiliateParam),
        },
        {
          label: `Bet ${finding.sideB.label}`.slice(0, 60),
          kind: "url",
          payload: polymarketUrl(marketById.get(finding.sideB.marketId), affiliateParam),
        },
      ];

  return {
    status: "success",
    verb: "prediction_market_finding",
    headline: PATTERN_HEADLINES[finding.patternType],
    fields,
    details,
    complexity: "complex",
    nextActions,
  };
}

export class PredictionMarketFindingBroadcaster
  implements IPredictionMarketFindingBroadcaster
{
  constructor(private readonly deps: PredictionMarketFindingBroadcasterDeps) {}

  async broadcast(input: FindingBroadcastInput): Promise<FindingBroadcastResult> {
    const { runId, reqId, findings, clusterById, marketById } = input;
    const start = Date.now();
    log.info({ step: "started", reqId, runId, findings: findings.length }, "broadcast");

    if (findings.length === 0) {
      log.info(
        { step: "succeeded", reqId, runId, sent: 0, skipped: 0, durationMs: Date.now() - start },
        "broadcast",
      );
      return { sent: 0, skipped: 0 };
    }

    const userIds = await this.deps.listActiveUserIds().catch((err) => {
      log.error({ err, reqId }, "broadcast listActiveUserIds failed");
      return [] as string[];
    });
    if (userIds.length === 0) {
      log.info(
        { step: "succeeded", reqId, runId, sent: 0, skipped: 0, durationMs: Date.now() - start },
        "broadcast",
      );
      return { sent: 0, skipped: 0 };
    }

    // Pre-render per finding once. ChatId is invariant within a tick — also
    // resolved per user once, below, so we don't hit the session table F×U times.
    const renderedFindings = findings
      .map((finding) => {
        const cluster = clusterById.get(finding.clusterId);
        if (!cluster) {
          log.warn(
            { reqId, findingId: finding.findingId, clusterId: finding.clusterId },
            "missing cluster context",
          );
          return null;
        }
        const result = buildResult({
          finding,
          cluster,
          marketById,
          affiliateParam: this.deps.affiliateParam,
        });
        return { finding, result, rendered: renderResultCard({ result }) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    let sent = 0;
    let skipped = 0;
    const limit = pLimit(this.deps.concurrency);

    // Outer fan-out across users (parallel, bounded). Per-user inner loop is
    // sequential so a single user sees findings arrive in rankScore order.
    await Promise.all(
      userIds.map((userId) =>
        limit(async () => {
          let chatIdRaw: string | null;
          try {
            chatIdRaw = await this.deps.getChatId(userId);
          } catch (err) {
            log.error({ err, userId, reqId }, "broadcast getChatId failed");
            return;
          }
          if (!chatIdRaw) {
            skipped += renderedFindings.length;
            return;
          }
          const chatId = Number(chatIdRaw);

          for (const { finding, result, rendered } of renderedFindings) {
            const dedupeKey = `pm:finding:lastSeen:${userId}:${finding.findingId}`;
            try {
              const seen = await this.deps.redis.get(dedupeKey);
              if (seen) {
                skipped += 1;
                continue;
              }
              try {
                await this.deps.tgApi.sendMessage(chatId, rendered.text, {
                  parse_mode: rendered.parseMode,
                  ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
                });
              } catch (err) {
                log.warn(
                  { err, userId, chatId, reqId, findingId: finding.findingId, mode: "markdownV2-retry-plain" },
                  "broadcast send retry",
                );
                const plain =
                  `${result.headline}\n` +
                  result.fields.map((f) => `${f.label}: ${f.value}`).join("\n") +
                  (result.details && result.details.length > 0
                    ? "\n\n" + result.details.map((d) => `• ${d.label}: ${d.value}`).join("\n")
                    : "");
                await this.deps.tgApi.sendMessage(chatId, plain, {
                  ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
                });
              }
              await this.deps.redis.set(dedupeKey, "1", "EX", BROADCAST_DEDUPE_TTL_SEC);
              sent += 1;
            } catch (err) {
              log.error({ err, userId, reqId, findingId: finding.findingId }, "per-user broadcast error");
            }
          }
        }),
      ),
    );

    log.info(
      { step: "succeeded", reqId, runId, sent, skipped, durationMs: Date.now() - start },
      "broadcast",
    );
    return { sent, skipped };
  }
}
