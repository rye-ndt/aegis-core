import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import { isRateLimitedError } from "../../../../helpers/errors/rateLimitedError";
import { isUnsupportedChainError } from "../../../../helpers/errors/unsupportedChainError";
import { getExplorerTxUrl } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";
import { newUuid } from "../../../../helpers/uuid";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { ITransferHistoryUseCase } from "../../../../use-cases/interface/input/transferHistory.interface";

const log = createLogger("getTransferHistoryTool");

const InputSchema = z.object({
  windowDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "How many days back to look, ending now. E.g. 1 = last 24h, 7 = last week, 30 = last month. Omit for unbounded (entire history).",
    ),
  direction: z
    .enum(["in", "out", "self"])
    .optional()
    .describe("Filter to one direction: 'in' = received, 'out' = sent, 'self' = self-transfer. Omit for all."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Page size, default 25, max 100."),
});

function fmtTimestamp(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return "—";
  // YYYY-MM-DD HH:mm UTC for compact tables
  const d = new Date(epoch * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export class GetTransferHistoryTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly useCase: ITransferHistoryUseCase,
    private readonly chainId: number,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GET_TRANSFER_HISTORY,
      description:
        "Look up the user's on-chain transfer history (sends + receives, native + ERC-20) " +
        "for their Smart Contract Account on the configured chain. Use when the user asks " +
        "about past activity, spending, receipts, or who paid them. Returns a Markdown table.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const requestId = newUuid().slice(0, 8);
    log.info({ step: "started", userId: this.userId, requestId }, "history-tool");
    log.debug(
      {
        userId: this.userId,
        requestId,
        argCount: Object.keys(input ?? {}).length,
        direction: input?.direction,
        windowDays: input?.windowDays,
      },
      "history-tool-input",
    );

    const parsed = InputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      log.warn({ requestId, issues: parsed.error.issues }, "history-tool-invalid-input");
      return { success: false, error: "invalid-input" };
    }

    let fromEpoch: number | undefined;
    let toEpoch: number | undefined;
    if (parsed.data.windowDays != null) {
      toEpoch = Math.floor(Date.now() / 1000);
      fromEpoch = toEpoch - parsed.data.windowDays * 86_400;
    }

    try {
      const page = await this.useCase.getHistory({
        userId: this.userId,
        fromEpoch,
        toEpoch,
        direction: parsed.data.direction,
        limit: parsed.data.limit,
      });

      if (page.items.length === 0) {
        log.info({ step: "succeeded", userId: this.userId, requestId, count: 0 }, "history-tool");
        return {
          success: true,
          data: "No transfers found for the given window.",
          structured: { kind: "transfer_history", items: [], nextCursor: null },
        };
      }

      const rows: string[] = [
        "When | Direction | Token | Amount | Counterparty | Label | Tx",
        "-----|-----------|-------|--------|--------------|-------|----",
      ];
      for (const it of page.items) {
        const counterparty =
          it.direction === "out" ? it.to :
          it.direction === "in" ? it.from :
          it.from;
        const txUrl = getExplorerTxUrl(it.chainId, it.txHash);
        const txCell = txUrl ? `[${shortHash(it.txHash)}](${txUrl})` : shortHash(it.txHash);
        const symbol = it.tokenSymbol || (it.isNative ? "(native)" : "(unknown)");
        const label = it.label ?? "—";
        rows.push(
          `${fmtTimestamp(it.timestampEpoch)} | ${it.direction} | ${symbol} | ${it.amountFormatted} | ${shortAddr(counterparty)} | ${label} | ${txCell}`,
        );
      }

      if (page.nextCursor) {
        rows.push("");
        rows.push("_More results available — narrow the time window or ask for the next page._");
      }

      log.info(
        { step: "succeeded", userId: this.userId, requestId, count: page.items.length },
        "history-tool",
      );
      return {
        success: true,
        data: rows.join("\n"),
        structured: {
          kind: "transfer_history",
          items: page.items.map((it) => ({
            direction: it.direction,
            tokenSymbol: it.tokenSymbol || (it.isNative ? "(native)" : "(unknown)"),
            amountFormatted: it.amountFormatted,
            counterparty:
              it.direction === "out" ? it.to :
              it.direction === "in" ? it.from :
              it.from,
            timestampEpoch: it.timestampEpoch,
            txHash: it.txHash,
            chainId: it.chainId,
            label: it.label ?? null,
          })),
          nextCursor: page.nextCursor ?? null,
        },
      };
    } catch (err) {
      if (isRateLimitedError(err)) {
        log.warn({ step: "failed", userId: this.userId, requestId, reason: "rate-limited" }, "history-tool");
        return { success: false, error: "history-rate-limited" };
      }
      if (isUnsupportedChainError(err)) {
        log.warn({ step: "failed", userId: this.userId, requestId, reason: "unsupported-chain", chainId: err.chainId }, "history-tool");
        return { success: false, error: "history-unavailable-on-this-chain" };
      }
      log.error({ err, userId: this.userId, requestId, step: "failed" }, "history-tool");
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
