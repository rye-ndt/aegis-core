import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IStockUseCase } from "../../../../use-cases/interface/input/stock.interface";

const log = createLogger("getStockPositionsTool");

const InputSchema = z.object({});

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 10)}…` : h;
}

export class GetStockPositionsTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly getStockUseCase: () => IStockUseCase | null,
    private readonly isDisabled: () => boolean,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GET_STOCK_POSITIONS,
      description:
        "Read-only listing of the user's open tokenized-stock positions on Aster (BSC). " +
        "Returns a table of symbol, side, entry price, mark, P&L, SL/TP, and tradeHash. " +
        "Use when the user asks about open positions or P&L. Does NOT execute trades or close anything.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    const requestId = newUuid().slice(0, 8);
    log.info({ step: "started", userId: this.userId, requestId }, "stock-positions-tool");

    if (this.isDisabled()) {
      log.warn({ step: "failed", requestId, reason: "disabled" }, "stock-positions-tool");
      return { success: false, error: "stocks_unavailable" };
    }
    const stockUseCase = this.getStockUseCase();
    if (!stockUseCase) {
      log.warn({ step: "failed", requestId, reason: "not-initialised" }, "stock-positions-tool");
      return { success: false, error: "stocks_unavailable" };
    }

    try {
      const positions = await stockUseCase.listPositions(this.userId);
      if (positions.length === 0) {
        log.info({ step: "succeeded", userId: this.userId, requestId, count: 0 }, "stock-positions-tool");
        return { success: true, data: "No open stock positions." };
      }
      const rows: string[] = [
        "Symbol | Side | Entry | Mark | Collateral | P&L | SL | TP | Trade",
        "-------|------|-------|------|------------|-----|----|----|------",
      ];
      for (const p of positions) {
        rows.push(
          `${p.symbol} | ${p.side} | $${p.entryPriceUsd} | $${p.markPriceUsd} | $${p.collateralUsd} | ${p.unrealizedPnlUsd} | ${p.stopLossUsd ?? "—"} | ${p.takeProfitUsd ?? "—"} | ${shortHash(p.tradeHash)}`,
        );
      }
      log.info(
        { step: "succeeded", userId: this.userId, requestId, count: positions.length },
        "stock-positions-tool",
      );
      return { success: true, data: rows.join("\n") };
    } catch (err) {
      log.error({ err, userId: this.userId, requestId, step: "failed" }, "stock-positions-tool");
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
