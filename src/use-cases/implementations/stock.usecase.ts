import { formatUnits } from "viem";
import type {
  IStockUseCase,
  BuyPlanInput,
  ClosePlanInput,
  SetExitsPlanInput,
  StockExecutionPlan,
  StockExecutionStep,
  PositionResolution,
} from "../interface/input/stock.interface";
import type { IStockBrokerProvider } from "../interface/output/stocks/stockBrokerProvider.interface";
import type {
  IStockPositionsProvider,
  StockPosition,
} from "../interface/output/stocks/stockPositionsProvider.interface";
import type { IStockPriceOracle } from "../interface/output/stocks/stockPriceOracle.interface";
import type { IStockPairRegistry } from "../interface/output/stocks/stockPair.interface";
import type { ICrossChainSwapPlanner } from "../interface/output/stocks/crossChainSwapPlanner.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { ITokenRegistryService } from "../interface/output/tokenRegistry.interface";
import { divFixed, toRaw } from "../../helpers/bigint";
import { CHAIN_CONFIG, getUsdcAddress } from "../../helpers/chainConfig";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("stockUseCase");

export interface StockUseCaseDeps {
  broker: IStockBrokerProvider;
  /** Per-user-bound positions provider factory (matches transferHistory pattern). */
  positions: (userId: string) => IStockPositionsProvider;
  oracle: IStockPriceOracle;
  pairs: IStockPairRegistry;
  crossChainSwap: ICrossChainSwapPlanner;
  userProfileRepo: IUserProfileDB;
  tokenRegistry: ITokenRegistryService;
}

/**
 * Orchestrates the deterministic execution plan for a stock action. Stays
 * chain-agnostic: home chain reads `CHAIN_CONFIG.chainId`, venue chain
 * reads `broker.venueChainId`. The only chain-specific knowledge in this
 * file lives behind those two reads.
 */
export class StockUseCaseImpl implements IStockUseCase {
  constructor(private readonly deps: StockUseCaseDeps) {}

  private get homeChainId(): number {
    return CHAIN_CONFIG.chainId;
  }

  private get venueChainId(): number {
    return this.deps.broker.venueChainId;
  }

  async buildOpenPlan(input: BuyPlanInput): Promise<StockExecutionPlan> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!this.deps.pairs.resolve(symbol)) {
      log.warn({ step: "failed", symbol }, "unsupported stock symbol");
      throw new Error(`unsupported symbol ${symbol}`);
    }
    const sca = await this.requireSca(input.userId);

    const usdcHome = getUsdcAddress(this.homeChainId);
    if (!usdcHome) throw new Error("home-chain USDC not configured");
    const usdcHomeRow = await this.deps.tokenRegistry.findByAddressAndChain(
      usdcHome,
      this.homeChainId,
    );
    if (!usdcHomeRow) throw new Error("home USDC not in token registry");

    // 1. Mark price (used as the on-chain `price` field on openMarketTrade).
    const mark = await this.deps.oracle.markPrice(symbol);
    const markFixed1e8 = toRaw(mark.priceUsd, 8);

    // 2. Cross-chain swap leg via the port (fix #8).
    const amountHomeRaw = toRaw(input.amountUsd, usdcHomeRow.decimals);
    const swap = await this.deps.crossChainSwap.plan({
      user: sca,
      recipient: sca,
      fromChainId: this.homeChainId,
      toChainId: this.venueChainId,
      fromToken: usdcHome as `0x${string}`,
      toToken: this.deps.broker.collateralToken.address,
      amountRaw: amountHomeRaw,
    });
    if (swap.txs.length === 0) {
      throw new Error("cross-chain swap planner returned no txs");
    }
    if (!swap.expectedOutRaw || swap.expectedOutRaw === "0") {
      throw new Error("swap planner missing expectedOutRaw — cannot size open leg");
    }

    // 3. Derive qty from delivered collateral (post-fee/slippage). Sizing
    //    qty from the user's input USD would silently mis-leverage the open
    //    when the bridge fee eats into amountIn (fix #6).
    const collateralAmountRaw = swap.expectedOutRaw;
    const collateralDecimals = this.deps.broker.collateralToken.decimals;
    const collateralUsdHuman = formatUnits(
      BigInt(collateralAmountRaw),
      collateralDecimals,
    );
    const qty1e10 = divFixed(collateralUsdHuman, mark.priceUsd, 10);

    // 4. Build venue-chain open txs (approve? + openMarketTrade).
    const openTxs = await this.deps.broker.buildOpenPositionTxs({
      traderAddress: sca,
      symbol,
      isLong: !input.isShort,
      collateralAmountRaw,
      qtyFixed1e10: qty1e10,
      markPriceFixed1e8: markFixed1e8,
      stopLossFixed1e8: undefined,
      takeProfitFixed1e8: undefined,
    });

    // 5. Sequence steps. Tag the LAST swap leg with home-chain spend so the
    //    delegation row's spent_raw bumps once on success (matches
    //    swapCapability's last-step convention).
    const steps: StockExecutionStep[] = [];
    swap.txs.forEach((tx, i) => {
      const isLast = i === swap.txs.length - 1;
      steps.push({
        label:
          swap.txs.length === 1
            ? "Bridge USDC to BSC"
            : `Bridge step ${i + 1}/${swap.txs.length}`,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? "0",
        chainId: this.homeChainId,
        spendTokenAddress: isLast ? usdcHome.toLowerCase() : undefined,
        spendAmountRaw: isLast ? amountHomeRaw : undefined,
      });
    });
    openTxs.forEach((tx, i) => {
      const total = openTxs.length;
      const label =
        total === 1
          ? "Open stock position"
          : i === 0 && total === 2
            ? "Approve USDC for Aster"
            : "Open stock position";
      steps.push({
        label,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chainId: this.venueChainId,
      });
    });

    log.info(
      {
        step: "plan-built",
        userId: input.userId,
        symbol,
        side: input.isShort ? "short" : "long",
        amountUsd: input.amountUsd,
        markPrice: mark.priceUsd,
        notionalUsd: input.amountUsd,
        venueChainId: this.venueChainId,
        stepCount: steps.length,
      },
      "open plan built",
    );

    return {
      kind: input.isShort ? "short" : "buy",
      symbol,
      steps,
      quoteSummary: buildOpenQuoteSummary({
        symbol,
        amountUsd: input.amountUsd,
        markPriceUsd: mark.priceUsd,
        isShort: !!input.isShort,
        stepCount: steps.length,
      }),
    };
  }

  async buildClosePlan(input: ClosePlanInput): Promise<StockExecutionPlan> {
    const sca = await this.requireSca(input.userId);

    // Fix #1 — resolve the symbol from the cached positions list so the
    // success/failure message can render "Closing AAPL long…" instead of a
    // placeholder.
    const positions = await this.deps.positions(input.userId).list(sca);
    const match = positions.find((p) => p.tradeHash === input.tradeHash);
    if (!match) {
      throw new Error(
        `no open position with tradeHash ${input.tradeHash.slice(0, 10)}`,
      );
    }

    const closeTxs = await this.deps.broker.buildClosePositionTxs({
      tradeHash: input.tradeHash,
    });

    const steps: StockExecutionStep[] = closeTxs.map((tx) => ({
      label: "Close stock position",
      to: tx.to,
      data: tx.data,
      value: tx.value,
      chainId: this.venueChainId,
    }));
    log.info(
      {
        step: "plan-built",
        userId: input.userId,
        symbol: match.symbol,
        side: match.side,
        venueChainId: this.venueChainId,
        stepCount: steps.length,
      },
      "close plan built",
    );

    return {
      kind: "close",
      symbol: match.symbol,
      steps,
      quoteSummary: `*Closing ${match.symbol} ${match.side}* — collateral $${match.collateralUsd}, P&L ${match.unrealizedPnlUsd} USD.`,
    };
  }

  async buildSetExitsPlan(
    input: SetExitsPlanInput,
  ): Promise<StockExecutionPlan> {
    const sca = await this.requireSca(input.userId);
    const positions = await this.deps.positions(input.userId).list(sca);
    const match = positions.find((p) => p.tradeHash === input.tradeHash);
    if (!match) {
      throw new Error(
        `no open position with tradeHash ${input.tradeHash.slice(0, 10)}`,
      );
    }

    // Pass-through unchanged side: only setting SL preserves existing TP.
    const finalSlHuman = input.stopLossUsd ?? match.stopLossUsd ?? "0";
    const finalTpHuman = input.takeProfitUsd ?? match.takeProfitUsd ?? "0";

    const txs = await this.deps.broker.buildSetExitsTxs({
      tradeHash: input.tradeHash,
      stopLossFixed1e8: toRaw(finalSlHuman, 8),
      takeProfitFixed1e8: toRaw(finalTpHuman, 8),
    });

    const steps: StockExecutionStep[] = txs.map((tx) => ({
      label: "Update SL/TP",
      to: tx.to,
      data: tx.data,
      value: tx.value,
      chainId: this.venueChainId,
    }));
    log.info(
      {
        step: "plan-built",
        userId: input.userId,
        symbol: match.symbol,
        venueChainId: this.venueChainId,
      },
      "set-exits plan built",
    );
    return {
      kind: "set_exits",
      symbol: match.symbol,
      steps,
      quoteSummary: `Updating exits for ${match.symbol} (SL ${finalSlHuman}, TP ${finalTpHuman})…`,
    };
  }

  async buildReturnSwapPlan(input: {
    userId: string;
  }): Promise<StockExecutionPlan | null> {
    const sca = await this.requireSca(input.userId);

    // Fix #7 — venue-chain balance read goes through the broker port.
    const balance = await this.deps.broker.getCollateralBalance(sca);
    if (balance === 0n) {
      log.info(
        { step: "recovery-noop", userId: input.userId, venueChainId: this.venueChainId },
        "no venue collateral to return",
      );
      return null;
    }

    const usdcHome = getUsdcAddress(this.homeChainId);
    if (!usdcHome) throw new Error("home-chain USDC not configured");

    const swap = await this.deps.crossChainSwap.plan({
      user: sca,
      recipient: sca,
      fromChainId: this.venueChainId,
      toChainId: this.homeChainId,
      fromToken: this.deps.broker.collateralToken.address,
      toToken: usdcHome as `0x${string}`,
      amountRaw: balance.toString(),
    });
    if (swap.txs.length === 0) {
      log.warn(
        { userId: input.userId, balance: balance.toString() },
        "recovery planner returned no txs",
      );
      return null;
    }

    const steps: StockExecutionStep[] = swap.txs.map((tx, i) => ({
      label:
        swap.txs.length === 1
          ? "Return USDC to home chain"
          : `Return step ${i + 1}/${swap.txs.length}`,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      chainId: this.venueChainId,
    }));

    log.info(
      {
        step: "recovery-plan-built",
        userId: input.userId,
        balance: balance.toString(),
        stepCount: steps.length,
      },
      "recovery plan built",
    );
    return {
      kind: "recovery",
      symbol: "",
      steps,
      quoteSummary: "Returning your funds to the home chain…",
    };
  }

  async listPositions(userId: string): Promise<StockPosition[]> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    if (!profile?.smartAccountAddress) return [];
    return this.deps
      .positions(userId)
      .list(profile.smartAccountAddress as `0x${string}`);
  }

  async resolvePositionForSymbol(
    userId: string,
    symbol: string,
  ): Promise<PositionResolution> {
    const upper = symbol.trim().toUpperCase();
    const all = await this.listPositions(userId);
    const matches = all.filter((p) => p.symbol === upper);
    if (matches.length === 0) return { kind: "none" };
    if (matches.length === 1) return { kind: "one", position: matches[0]! };
    return { kind: "many", positions: matches };
  }

  private async requireSca(userId: string): Promise<`0x${string}`> {
    const profile = await this.deps.userProfileRepo.findByUserId(userId);
    const sca = profile?.smartAccountAddress as `0x${string}` | undefined;
    if (!sca) {
      log.warn({ userId }, "user has no smart account address");
      throw new Error("user has no smart account address");
    }
    return sca;
  }
}

function buildOpenQuoteSummary(args: {
  symbol: string;
  amountUsd: string;
  markPriceUsd: string;
  isShort: boolean;
  stepCount: number;
}): string {
  const verb = args.isShort ? "Short" : "Buy";
  const lines = [
    `*${verb} ${args.symbol}*`,
    "",
    `Notional: $${args.amountUsd}`,
    `Mark: $${args.markPriceUsd}`,
    `Leverage: 1×`,
    `Steps: ${args.stepCount} (cross-chain bridge → open)`,
    "",
    "Tap below — all steps will be signed in one mini-app session.",
  ];
  return lines.join("\n");
}
