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
import type { IStockPriceOracle } from "../../../../use-cases/interface/output/stocks/stockPriceOracle.interface";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";

const log = createLogger("getStockQuoteTool");

const InputSchema = z.object({
  symbols: z
    .array(z.string().min(1).max(10))
    .min(1)
    .max(20)
    .describe(
      "List of stock ticker symbols (uppercase, e.g. ['AAPL','TSLA']). Use the get_stock_pairs catalogue if unsure which symbols are tradable.",
    ),
});

export class GetStockQuoteTool implements ITool {
  constructor(
    private readonly oracle: IStockPriceOracle,
    private readonly pairs: IStockPairRegistry,
    private readonly isDisabled: () => boolean,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GET_STOCK_QUOTE,
      description:
        "Read-only mark prices for tokenized stocks tradable on Aster. Returns the current USD mark per symbol. " +
        "Use when the user asks about a stock price or wants a quote before opening a position. Does NOT execute trades.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const requestId = newUuid().slice(0, 8);
    log.info({ step: "started", requestId }, "stock-quote-tool");

    if (this.isDisabled()) {
      log.warn({ step: "failed", requestId, reason: "disabled" }, "stock-quote-tool");
      return { success: false, error: "stocks_unavailable" };
    }

    const parsed = InputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      log.warn({ requestId, issues: parsed.error.issues }, "stock-quote-invalid-input");
      return { success: false, error: "invalid-input" };
    }

    const requested = parsed.data.symbols.map((s) => s.trim().toUpperCase());
    const supported = new Set(this.pairs.symbols().map((s) => s.toUpperCase()));
    const unknown = requested.filter((s) => !supported.has(s));
    if (unknown.length > 0) {
      log.warn({ requestId, unknown }, "stock-quote-unknown-symbols");
      return {
        success: false,
        error: `unknown stock symbols: ${unknown.join(", ")}. Supported: ${[...supported].join(", ")}`,
      };
    }

    try {
      const marks = await this.oracle.markPrices(requested);
      if (marks.length === 0) {
        return {
          success: true,
          data: "No marks available.",
          structured: { kind: "stock_quote", items: [] },
        };
      }
      const rows: string[] = ["Symbol | Mark (USD) | As-of (UTC)", "-------|-----------|-----------"];
      for (const m of marks) {
        const ts = new Date(m.asOfEpoch * 1000).toISOString().replace("T", " ").slice(0, 16);
        rows.push(`${m.symbol} | $${m.priceUsd} | ${ts}`);
      }
      log.info({ step: "succeeded", requestId, count: marks.length }, "stock-quote-tool");
      return {
        success: true,
        data: rows.join("\n"),
        structured: {
          kind: "stock_quote",
          items: marks.map((m) => ({ symbol: m.symbol, priceUsd: m.priceUsd, asOfEpoch: m.asOfEpoch })),
        },
      };
    } catch (err) {
      log.error({ err, requestId, step: "failed" }, "stock-quote-tool");
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
