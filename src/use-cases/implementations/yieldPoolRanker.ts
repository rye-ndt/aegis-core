import type { YIELD_PROTOCOL_ID } from "../../helpers/enums/yieldProtocolId.enum";
import type { PoolStatus } from "../interface/yield/IYieldProtocolAdapter";
import type { IYieldPoolRanker, RankedPool } from "../interface/yield/IYieldPoolRanker";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("yieldPoolRanker");

const MIN_LIQUIDITY_USD = 100_000;
const HIGH_UTILIZATION_THRESHOLD = 0.95;
const HIGH_UTILIZATION_PENALTY = 0.5;
const EMA_WEIGHT = 0.7;
const CURRENT_WEIGHT = 0.3;

function computeScore(currentApy: number, history: number[]): number {
  const ema =
    history.length > 0
      ? history.reduce((acc, v) => acc + v, 0) / history.length
      : currentApy;

  return EMA_WEIGHT * ema + CURRENT_WEIGHT * currentApy;
}

export class YieldPoolRanker implements IYieldPoolRanker {
  rank(
    statuses: Array<{ protocolId: YIELD_PROTOCOL_ID; status: PoolStatus }>,
    history: Partial<Record<YIELD_PROTOCOL_ID, number[]>>,
    tokenDecimals: number,
  ): RankedPool[] {
    const ranked: RankedPool[] = [];

    for (const { protocolId, status } of statuses) {
      const liquidityUsd =
        Number(status.liquidityRaw) / Math.pow(10, tokenDecimals);
      if (liquidityUsd < MIN_LIQUIDITY_USD) {
        log.debug({ choice: "skip", reason: "low-liquidity", protocolId, liquidityUsd }, "pool disqualified");
        continue;
      }

      let score = computeScore(status.supplyApy, history[protocolId] ?? []);

      if (status.utilization > HIGH_UTILIZATION_THRESHOLD) {
        log.debug(
          { choice: "penalty", reason: "high-utilization", protocolId, utilization: status.utilization },
          "pool penalized",
        );
        score *= HIGH_UTILIZATION_PENALTY;
      }

      log.info(
        { step: "pool-ranked", protocolId, score, apy: status.supplyApy, liquidityUsd, utilization: status.utilization },
        "pool ranked",
      );
      ranked.push({ protocolId, score, apy: status.supplyApy });
    }

    return ranked.sort((a, b) => b.score - a.score);
  }
}
