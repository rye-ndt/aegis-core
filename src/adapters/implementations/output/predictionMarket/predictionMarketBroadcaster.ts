import type { Api } from "grammy";
import type Redis from "ioredis";
import pLimit from "p-limit";
import { createLogger } from "../../../../helpers/observability/logger";
import type { IPredictionMarketBroadcaster } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBroadcaster";
import type { DraftCluster } from "../../../../use-cases/interface/predictionMarket/PredictionMarketTypes";
import type {
  IntentResult,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import { renderResultCard } from "../artifactRenderer/resultCard.render";

const log = createLogger("predictionMarketBroadcaster");

const BROADCAST_DEDUPE_TTL_SEC = 7 * 24 * 60 * 60;

export interface PredictionMarketBroadcasterDeps {
  tgApi: Api;
  redis: Redis;
  listActiveUserIds: () => Promise<string[]>;
  getChatId: (userId: string) => Promise<string | null>;
  concurrency: number;
}

function buildResult(args: {
  runId: string;
  clusters: DraftCluster[];
}): IntentResult {
  const { runId, clusters } = args;
  const fields: ResultField[] = [
    {
      label: "Clusters surfaced",
      value: String(clusters.length),
      emphasis: "primary",
    },
    {
      label: "Run",
      value: runId.slice(0, 8),
      emphasis: "muted",
    },
  ];
  const details: ResultField[] = clusters.map((c) => ({
    label: c.theme,
    value: `${c.causalDriver} · ${c.marketIds.length} markets`,
  }));
  return {
    status: "success",
    verb: "prediction_market_brief",
    headline: "Today's prediction-market clusters",
    fields,
    details,
    complexity: "complex",
    nextActions: [],
  };
}

export class PredictionMarketBroadcaster implements IPredictionMarketBroadcaster {
  constructor(private readonly deps: PredictionMarketBroadcasterDeps) {}

  async broadcast(args: {
    runId: string;
    clusterSetHash: string;
    clusters: DraftCluster[];
    reqId: string;
  }): Promise<{ sent: number; skipped: number }> {
    const { runId, clusterSetHash, clusters, reqId } = args;
    const start = Date.now();
    log.info({ step: "started", reqId, runId, clusters: clusters.length }, "broadcast");

    const userIds = await this.deps.listActiveUserIds().catch((err) => {
      log.error({ err, reqId }, "broadcast listActiveUserIds failed");
      return [] as string[];
    });

    if (userIds.length === 0) {
      log.info({ step: "succeeded", reqId, runId, sent: 0, skipped: 0, durationMs: Date.now() - start }, "broadcast");
      return { sent: 0, skipped: 0 };
    }

    const result = buildResult({ runId, clusters });
    const rendered = renderResultCard({ result });

    const limit = pLimit(this.deps.concurrency);
    let sent = 0;
    let skipped = 0;

    await Promise.all(
      userIds.map((userId) =>
        limit(async () => {
          const dedupeKey = `pm:broadcast:lastHash:${userId}`;
          try {
            const last = await this.deps.redis.get(dedupeKey);
            if (last === clusterSetHash) {
              skipped += 1;
              return;
            }
            const chatId = await this.deps.getChatId(userId);
            if (!chatId) {
              skipped += 1;
              return;
            }
            try {
              await this.deps.tgApi.sendMessage(Number(chatId), rendered.text, {
                parse_mode: rendered.parseMode,
                ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
              });
            } catch (err) {
              // MarkdownV2 occasionally rejects on edge characters in market
              // questions. Fall back to a plain-text version mirroring the
              // yield-report sender's pattern.
              log.warn({ err, userId, chatId, reqId, mode: "markdownV2-retry-plain" }, "broadcast send retry");
              const plain =
                `${result.headline}\n` +
                result.fields.map((f) => `${f.label}: ${f.value}`).join("\n") +
                (result.details && result.details.length > 0
                  ? "\n\n" + result.details.map((d) => `• ${d.label}: ${d.value}`).join("\n")
                  : "");
              await this.deps.tgApi.sendMessage(Number(chatId), plain);
            }
            await this.deps.redis.set(dedupeKey, clusterSetHash, "EX", BROADCAST_DEDUPE_TTL_SEC);
            sent += 1;
          } catch (err) {
            log.error({ err, userId, reqId }, "per-user broadcast error");
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
