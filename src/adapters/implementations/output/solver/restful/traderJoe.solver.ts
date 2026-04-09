import type { ISolver } from "../../../../../use-cases/interface/output/solver/solver.interface";
import type { IntentPackage } from "../../../../../use-cases/interface/output/intentParser.interface";

// TODO: rebuild after token resolution step is added to the pipeline
// TraderJoeSolver requires resolved tokenIn/tokenOut (address, decimals, amountRaw)
// which are no longer part of IntentPackage at parse time.

// const NATIVE_AVAX = "0x0000000000000000000000000000000000000000";

// interface TraderJoeQuoteResponse {
//   route?: {
//     routeAddresses: string[];
//     routeTokens: string[];
//     amounts: string[];
//   };
//   calldata?: string;
//   routerAddress?: string;
// }

export class TraderJoeSolver implements ISolver {
  readonly name = "trader_joe_v2_solver";

  constructor(
    private readonly traderJoeApiUrl: string,
    private readonly chainId: number,
  ) {}

  async buildCalldata(
    _intent: IntentPackage,
    _userAddress: string,
  ): Promise<{ to: string; data: string; value: string }> {
    throw new Error("TraderJoeSolver: not available until token resolution step is implemented");

    // TODO: restore after token resolution step is added
    // if (!intent.tokenIn || !intent.tokenOut) {
    //   throw new Error("TraderJoeSolver requires tokenIn and tokenOut");
    // }
    // const tokenIn = intent.tokenIn.address === NATIVE_AVAX ? "AVAX" : intent.tokenIn.address;
    // const params = new URLSearchParams({
    //   tokenIn,
    //   tokenOut: intent.tokenOut.address,
    //   amountIn: intent.tokenIn.amountRaw,
    //   slippage: ((intent.slippageBps ?? 50) / 100).toString(),
    //   to: userAddress,
    //   chainId: this.chainId.toString(),
    // });
    // const response = await fetch(`${this.traderJoeApiUrl}/v1/quote?${params.toString()}`);
    // if (!response.ok) {
    //   throw new Error(`TraderJoe API error: ${response.status} ${response.statusText}`);
    // }
    // const quote = await response.json() as TraderJoeQuoteResponse;
    // if (!quote.calldata || !quote.routerAddress) {
    //   throw new Error("TraderJoe API returned incomplete quote");
    // }
    // const isNativeIn = intent.tokenIn.address === NATIVE_AVAX;
    // const value = isNativeIn ? intent.tokenIn.amountRaw : "0";
    // return { to: quote.routerAddress, data: quote.calldata, value };
  }
}
