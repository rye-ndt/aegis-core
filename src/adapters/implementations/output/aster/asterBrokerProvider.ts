import { encodeFunctionData, erc20Abi } from "viem";
import type {
  IStockBrokerProvider,
  OpenPositionParams,
  ClosePositionParams,
  SetExitsParams,
  UnsignedTx,
} from "../../../../use-cases/interface/output/stocks/stockBrokerProvider.interface";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { IStockPairRegistry } from "../../../../use-cases/interface/output/stocks/stockPair.interface";
import type { AsterDiamondClient } from "./asterDiamond.client";
import { ASTER_PORTAL_ABI } from "./asterAbi";
import { ASTER_ENV } from "../../../../helpers/env/asterEnv";
import { getUsdcAddress } from "../../../../helpers/chainConfig";
import { createLogger } from "../../../../helpers/observability/logger";

const MAX_UINT256 = (2n ** 256n - 1n);

const log = createLogger("asterBrokerProvider");

/**
 * Adapter-bound chain id. Per the user-locked constraint ("the bsc lock is
 * only applied to aster provider"), 56 is the one place a literal chain id
 * lives outside `chainConfig.ts`. The collateral token address and decimals
 * are NOT hardcoded — they come from `getUsdcAddress(56)` and the
 * `token_registry` row, both of which are config-layer reads.
 */
const VENUE_CHAIN_ID = 56;

/**
 * Phase 1 ships the broker provider so DI can wire it (and the Phase 1
 * verify script can sanity-check the adapter shape). The transaction-
 * building methods are exercised by Phase 2's StockUseCase.
 */
export class AsterBrokerProvider implements IStockBrokerProvider {
  readonly venueChainId = VENUE_CHAIN_ID;
  readonly diamondAddress: `0x${string}` = ASTER_ENV.diamondAddressBsc;
  readonly collateralToken: {
    address: `0x${string}`;
    decimals: number;
    symbol: string;
  };

  static async create(
    diamond: AsterDiamondClient,
    pairs: IStockPairRegistry,
    tokenRegistry: ITokenRegistryService,
  ): Promise<AsterBrokerProvider> {
    const usdcAddr = getUsdcAddress(VENUE_CHAIN_ID);
    if (!usdcAddr) {
      throw new Error(
        "BSC_USDC env not set — required for AsterBrokerProvider",
      );
    }
    const row = await tokenRegistry.findByAddressAndChain(
      usdcAddr,
      VENUE_CHAIN_ID,
    );
    if (!row) {
      throw new Error(
        `USDC.bsc (${usdcAddr}) not found in token_registry — seed it before booting`,
      );
    }
    return new AsterBrokerProvider(diamond, pairs, {
      address: usdcAddr as `0x${string}`,
      decimals: row.decimals,
      symbol: row.symbol,
    });
  }

  private constructor(
    private readonly diamond: AsterDiamondClient,
    // Phase 1 leaves `pairs` unused but the dep is fixed in the constructor
    // shape so Phase 2 (which builds open txs) doesn't need a DI shuffle.
    private readonly pairs: IStockPairRegistry,
    collateralToken: {
      address: `0x${string}`;
      decimals: number;
      symbol: string;
    },
  ) {
    this.collateralToken = collateralToken;
    log.debug(
      {
        venueChainId: this.venueChainId,
        collateralAddress: collateralToken.address,
        collateralDecimals: collateralToken.decimals,
      },
      "broker provider built",
    );
  }

  async hasApproval(
    trader: `0x${string}`,
    requiredAmountRaw: string,
  ): Promise<boolean> {
    const allowance = (await this.diamond.publicClient.readContract({
      address: this.collateralToken.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [trader, this.diamondAddress],
    })) as bigint;
    return BigInt(allowance) >= BigInt(requiredAmountRaw);
  }

  async getCollateralBalance(trader: `0x${string}`): Promise<bigint> {
    const bal = (await this.diamond.publicClient.readContract({
      address: this.collateralToken.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [trader],
    })) as bigint;
    return BigInt(bal);
  }

  async buildOpenPositionTxs(p: OpenPositionParams): Promise<UnsignedTx[]> {
    const pairBase = this.pairs.resolve(p.symbol);
    if (!pairBase) {
      log.error({ symbol: p.symbol }, "open: unknown symbol");
      throw new Error(`unknown symbol ${p.symbol}`);
    }

    const txs: UnsignedTx[] = [];

    // Approve once to max — saves gas on subsequent opens. The Diamond is
    // upgrade-stable at the proxy address so a max approve is acceptable.
    if (!(await this.hasApproval(p.traderAddress, p.collateralAmountRaw))) {
      txs.push({
        to: this.collateralToken.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [this.diamondAddress, MAX_UINT256],
        }),
        value: "0",
      });
    }

    txs.push({
      to: this.diamondAddress,
      data: encodeFunctionData({
        abi: ASTER_PORTAL_ABI,
        functionName: "openMarketTrade",
        args: [
          {
            pairBase,
            isLong: p.isLong,
            tokenIn: this.collateralToken.address,
            amountIn: BigInt(p.collateralAmountRaw),
            qty: BigInt(p.qtyFixed1e10),
            price: BigInt(p.markPriceFixed1e8),
            stopLoss: BigInt(p.stopLossFixed1e8 ?? "0"),
            takeProfit: BigInt(p.takeProfitFixed1e8 ?? "0"),
            broker: ASTER_ENV.brokerId,
          },
        ],
      }),
      value: "0",
    });

    log.debug(
      { symbol: p.symbol, isLong: p.isLong, txCount: txs.length },
      "open txs built",
    );
    return txs;
  }

  async buildClosePositionTxs(p: ClosePositionParams): Promise<UnsignedTx[]> {
    return [
      {
        to: this.diamondAddress,
        data: encodeFunctionData({
          abi: ASTER_PORTAL_ABI,
          functionName: "closeTrade",
          args: [p.tradeHash],
        }),
        value: "0",
      },
    ];
  }

  async buildSetExitsTxs(p: SetExitsParams): Promise<UnsignedTx[]> {
    return [
      {
        to: this.diamondAddress,
        data: encodeFunctionData({
          abi: ASTER_PORTAL_ABI,
          functionName: "updateTradeTpAndSl",
          args: [
            p.tradeHash,
            BigInt(p.stopLossFixed1e8),
            BigInt(p.takeProfitFixed1e8),
          ],
        }),
        value: "0",
      },
    ];
  }
}
