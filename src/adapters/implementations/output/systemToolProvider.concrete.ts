import type { ITool } from "../../../use-cases/interface/output/tool.interface";
import type { ISystemToolProvider } from "../../../use-cases/interface/output/systemToolProvider.interface";
import type { IWalletDataProvider } from "../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../use-cases/interface/output/cache/userProfile.cache";
import type { ITransferHistoryUseCase } from "../../../use-cases/interface/input/transferHistory.interface";
import type { IStockPriceOracle } from "../../../use-cases/interface/output/stocks/stockPriceOracle.interface";
import type { IStockPairRegistry } from "../../../use-cases/interface/output/stocks/stockPair.interface";
import type { IStockUseCase } from "../../../use-cases/interface/input/stock.interface";
import { WalletBalancesTool } from "./tools/system/walletBalances.tool";
import { TransactionStatusTool } from "./tools/system/transactionStatus.tool";
import { GasSpendTool } from "./tools/system/gasSpend.tool";
import { RpcProxyTool } from "./tools/system/rpcProxy.tool";
import { GetTransferHistoryTool } from "./tools/getTransferHistory.tool";
import { GetStockQuoteTool } from "./tools/getStockQuote.tool";
import { GetStockPositionsTool } from "./tools/getStockPositions.tool";

export interface StockToolDeps {
  oracle: IStockPriceOracle;
  pairs: IStockPairRegistry;
  getStockUseCase: () => IStockUseCase | null;
  isDisabled: () => boolean;
}

export class SystemToolProviderConcrete implements ISystemToolProvider {
  constructor(
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
    private readonly transferHistoryUseCase: ITransferHistoryUseCase | undefined,
    private readonly chainId: number,
    private readonly stockToolDeps?: StockToolDeps,
  ) {}

  getTools(userId: string, _conversationId: string): ITool[] {
    const tools: ITool[] = [
      new WalletBalancesTool(userId, this.walletDataProvider, this.userProfileCache),
      new TransactionStatusTool(this.walletDataProvider),
      new GasSpendTool(userId, this.walletDataProvider, this.userProfileCache),
      new RpcProxyTool(userId, this.walletDataProvider, this.userProfileCache),
    ];
    if (this.transferHistoryUseCase) {
      tools.push(new GetTransferHistoryTool(userId, this.transferHistoryUseCase, this.chainId));
    }
    if (this.stockToolDeps) {
      const { oracle, pairs, getStockUseCase, isDisabled } = this.stockToolDeps;
      tools.push(new GetStockQuoteTool(oracle, pairs, isDisabled));
      tools.push(new GetStockPositionsTool(userId, getStockUseCase, isDisabled));
    }
    return tools;
  }
}
