import { z } from "zod";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../../use-cases/interface/output/tool.interface";
import type {
  IRelayClient,
  RelayTx,
} from "../../../../../use-cases/interface/output/relay.interface";
import {
  CHAIN_CONFIG,
  RELAY_SUPPORTED_CHAIN_IDS,
} from "../../../../../helpers/chainConfig";
import { toErrorMessage } from "../../../../../helpers/errors/toErrorMessage";

const NATIVE_CURRENCY_SENTINEL = "0x0000000000000000000000000000000000000000";

const InputSchema = z.object({
  tokenIn: z.string().describe("Origin-token address (0x…) or 'native' for the chain's native token"),
  tokenOut: z.string().describe("Destination-token address (0x…) or 'native' for the chain's native token"),
  amountRaw: z.string().describe("Raw amount in origin-token decimals (wei-precision string)"),
  fromChainId: z.number().int().describe(`Origin chain id (must be in RELAY_SUPPORTED_CHAIN_IDS)`),
  toChainId: z.number().int().describe(`Destination chain id (must be in RELAY_SUPPORTED_CHAIN_IDS)`),
  user: z.string().describe("SCA address initiating the swap"),
  recipient: z.string().describe("Destination-chain recipient; usually the same as `user`"),
});

export interface RelaySwapToolOutputData {
  txs: RelayTx[];
  outputAmount?: string;
  outputAmountFormatted?: string;
  fees?: Record<string, unknown>;
}

export class RelaySwapTool implements ITool {
  constructor(private readonly relayClient: IRelayClient) {}

  definition(): IToolDefinition {
    return {
      name: "relay_swap",
      description:
        "Fetch a cross-chain or same-chain swap quote from relay.link and return the ordered " +
        "list of transactions the user's wallet must sign. Intended for the /swap command path; " +
        "the capability layer is responsible for sequencing the signing step-by-step.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `INVALID_INPUT: ${parsed.error.message}` };
    }
    const p = parsed.data;

    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(p.fromChainId)) {
      return { success: false, error: `UNSUPPORTED_ORIGIN_CHAIN: ${p.fromChainId}` };
    }
    if (!RELAY_SUPPORTED_CHAIN_IDS.includes(p.toChainId)) {
      return { success: false, error: `UNSUPPORTED_DEST_CHAIN: ${p.toChainId}` };
    }

    try {
      const quote = await this.relayClient.getQuote({
        user: p.user,
        recipient: p.recipient,
        originChainId: p.fromChainId,
        destinationChainId: p.toChainId,
        originCurrency: normaliseCurrency(p.tokenIn),
        destinationCurrency: normaliseCurrency(p.tokenOut),
        amount: p.amountRaw,
        tradeType: "EXACT_INPUT",
      });

      const txs = quote.steps.flatMap((step) => step.items.map((item) => item.data));
      if (txs.length === 0) {
        return { success: false, error: "RELAY_QUOTE_EMPTY: no transactions returned" };
      }

      const data: RelaySwapToolOutputData = {
        txs,
        outputAmount: quote.details?.currencyOut?.amount,
        outputAmountFormatted: quote.details?.currencyOut?.amountFormatted,
        fees: quote.fees,
      };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}

/**
 * Relay accepts either a contract address or the zero address for a chain's
 * native currency. We accept the sentinel string `"native"` as shorthand.
 */
function normaliseCurrency(token: string): string {
  const lower = token.trim().toLowerCase();
  if (lower === "native" || lower === CHAIN_CONFIG.nativeSymbol.toLowerCase()) {
    return NATIVE_CURRENCY_SENTINEL;
  }
  return token;
}
