import { INTENT_COMMAND } from "../../../../helpers/enums/intentCommand.enum";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import { interpretError } from "../../../../helpers/errors/errorCatalog";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
  TriggerSpec,
} from "../../../../use-cases/interface/input/capability.interface";
import type {
  IntentResult,
  ResultField,
} from "../../../../use-cases/interface/input/resultCard.types";
import type { IStockUseCase } from "../../../../use-cases/interface/input/stock.interface";
import type { StockPosition } from "../../../../use-cases/interface/output/stocks/stockPositionsProvider.interface";

const log = createLogger("positionsCapability");

const MAX_FIELDS = 5;

type PositionsParams = Record<string, never>;

/**
 * `/positions` — read-only listing of open Aster stock positions, rendered as
 * a result-card receipt (verb: `positions_query`).
 *
 * Calls `IStockUseCase.listPositions` directly instead of round-tripping
 * through the LLM tool loop: the data is structured and the framework's
 * renderer is the only formatter we want users to see for terminal outputs
 * (plan §5.2.5). When the stock surface is disabled or unavailable we surface
 * a `failed` result-card via `interpretError` rather than a raw chat string.
 */
export class PositionsCapability implements Capability<PositionsParams> {
  readonly id = "intent_positions";
  readonly triggers: TriggerSpec = {
    commands: [INTENT_COMMAND.POSITIONS],
  };

  constructor(
    private readonly getStockUseCase: () => IStockUseCase | null,
    private readonly isDisabled: () => boolean,
  ) {}

  async collect(_ctx: CapabilityCtx): Promise<CollectResult<PositionsParams>> {
    return { kind: "ok", params: {} };
  }

  async run(_params: PositionsParams, ctx: CapabilityCtx): Promise<Artifact> {
    const requestId = newUuid();
    log.info({ step: "started", userId: ctx.userId, requestId }, "positions-list");

    if (this.isDisabled()) {
      return this.unavailableCard(requestId);
    }
    const useCase = this.getStockUseCase();
    if (!useCase) {
      return this.unavailableCard(requestId);
    }

    try {
      const positions = await useCase.listPositions(ctx.userId);
      log.info(
        { step: "succeeded", userId: ctx.userId, requestId, count: positions.length },
        "positions-list",
      );

      if (positions.length === 0) {
        const result: IntentResult = {
          status: "success",
          verb: "positions_query",
          headline: "No open stock positions",
          fields: [
            { label: "Status", value: "Nothing open right now", emphasis: "muted" },
          ],
          nextActions: [
            { label: "Browse stocks", kind: "command", payload: "/stock" },
          ],
          complexity: "simple",
        };
        return { kind: "result_card", result };
      }

      const fields: ResultField[] = positions.slice(0, MAX_FIELDS).map(toField);
      const details: ResultField[] = positions.slice(MAX_FIELDS).map(toField);

      const result: IntentResult = {
        status: "success",
        verb: "positions_query",
        headline: `Open positions: ${positions.length}`,
        fields,
        details: details.length > 0 ? details : undefined,
        nextActions: [
          { label: "Open another", kind: "command", payload: "/stock" },
        ],
        complexity: "simple",
      };
      return { kind: "result_card", result };
    } catch (err) {
      const interpreted = interpretError(err, { verb: "positions_query", requestId });
      const result: IntentResult = {
        status: "failed",
        verb: "positions_query",
        headline: "Couldn't load your positions",
        fields: [{ label: "Reason", value: interpreted.friendly }],
        complexity: "simple",
        requestId: interpreted.requestId,
    errorCode: interpreted.code,
        ...(interpreted.recovery
          ? {
              nextActions: [
                {
                  label: interpreted.recovery.label,
                  kind: interpreted.recovery.kind,
                  payload: interpreted.recovery.payload,
                },
              ],
            }
          : {}),
      };
      return { kind: "result_card", result };
    }
  }

  private unavailableCard(requestId: string): Artifact {
    const result: IntentResult = {
      status: "failed",
      verb: "positions_query",
      headline: "Stock trading isn't available right now",
      fields: [
        {
          label: "Reason",
          value: "The Aster surface is briefly unavailable. Please try again in a moment.",
        },
      ],
      complexity: "simple",
      requestId,
    };
    log.warn({ requestId }, "positions-list-unavailable");
    return { kind: "result_card", result };
  }
}

function toField(p: StockPosition): ResultField {
  const sign = p.unrealizedPnlUsd.startsWith("-") ? "" : "+";
  const pnl = `${sign}$${p.unrealizedPnlUsd}`;
  return {
    label: `${p.symbol} (${p.side})`,
    value: `Mark $${p.markPriceUsd} · P&L ${pnl}`,
  };
}
