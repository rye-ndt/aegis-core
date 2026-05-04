import type {
  CrossChainSwapPlan,
  CrossChainSwapPlanInput,
  ICrossChainSwapPlanner,
} from "../../../../use-cases/interface/output/stocks/crossChainSwapPlanner.interface";
import type { IRelayClient } from "../../../../use-cases/interface/output/relay.interface";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("relayCrossChainSwapPlanner");

const NATIVE_CURRENCY_SENTINEL = "0x0000000000000000000000000000000000000000";

/**
 * Wraps `IRelayClient.getQuote` behind the `ICrossChainSwapPlanner` port so
 * the stock use-case stays vendor-agnostic (fix #8). Returns the post-fee
 * `currencyOut.amount` as `expectedOutRaw` — the use-case derives qty from
 * this delivered amount, NOT from the user's input USD (fix #6).
 */
export class RelayCrossChainSwapPlanner implements ICrossChainSwapPlanner {
  constructor(private readonly relay: IRelayClient) {}

  async plan(input: CrossChainSwapPlanInput): Promise<CrossChainSwapPlan> {
    log.debug(
      {
        fromChainId: input.fromChainId,
        toChainId: input.toChainId,
        amountRaw: input.amountRaw,
      },
      "→ plan cross-chain swap",
    );
    const quote = await this.relay.getQuote({
      user: input.user,
      recipient: input.recipient,
      originChainId: input.fromChainId,
      destinationChainId: input.toChainId,
      originCurrency: normalise(input.fromToken),
      destinationCurrency: normalise(input.toToken),
      amount: input.amountRaw,
      tradeType: "EXACT_INPUT",
    });

    const txs = quote.steps.flatMap((s) =>
      s.items.map((item) => ({
        to: item.data.to as `0x${string}`,
        data: item.data.data as `0x${string}`,
        value: coerceValueToDecimal(item.data.value),
      })),
    );
    if (txs.length === 0) {
      log.warn(
        { fromChainId: input.fromChainId, toChainId: input.toChainId },
        "relay quote returned empty steps",
      );
    }

    const expectedOutRaw = quote.details?.currencyOut?.amount ?? "0";
    log.debug(
      { txCount: txs.length, expectedOutRaw },
      "← plan cross-chain swap",
    );
    return { txs, expectedOutRaw };
  }
}

/**
 * Relay quote `value` fields have shipped as both decimal strings and
 * 0x-prefixed hex in different shapes. The downstream signing-request
 * pipeline expects decimal raw, so we coerce defensively and warn loudly
 * when we hit a hex form so we can chase Relay-side drift.
 */
function coerceValueToDecimal(raw: string | undefined | null): string {
  if (raw == null || raw === "") return "0";
  if (typeof raw !== "string") return "0";
  if (/^0x[0-9a-fA-F]+$/.test(raw)) {
    const decimal = BigInt(raw).toString();
    log.warn({ raw, decimal }, "relay-value-hex-coerced");
    return decimal;
  }
  if (/^\d+$/.test(raw)) return raw;
  log.warn({ raw }, "relay-value-unrecognised-format");
  return "0";
}

function normalise(addr: `0x${string}`): string {
  // Relay accepts the zero address for native currency.
  return addr === ("0x0000000000000000000000000000000000000000" as `0x${string}`)
    ? NATIVE_CURRENCY_SENTINEL
    : addr;
}
