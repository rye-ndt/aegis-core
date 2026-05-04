import type { ITool } from "../../../use-cases/interface/output/tool.interface";
import type { ISystemToolProvider } from "../../../use-cases/interface/output/systemToolProvider.interface";
import type { IWalletDataProvider } from "../../../use-cases/interface/output/walletDataProvider.interface";
import type { IIntentUseCase } from "../../../use-cases/interface/input/intent.interface";
import type { IUserProfileCache } from "../../../use-cases/interface/output/cache/userProfile.cache";
import type { ITransferHistoryUseCase } from "../../../use-cases/interface/input/transferHistory.interface";
import { TransferErc20Tool } from "./tools/system/transferErc20.tool";
import { WalletBalancesTool } from "./tools/system/walletBalances.tool";
import { TransactionStatusTool } from "./tools/system/transactionStatus.tool";
import { GasSpendTool } from "./tools/system/gasSpend.tool";
import { RpcProxyTool } from "./tools/system/rpcProxy.tool";
import { GetTransferHistoryTool } from "./tools/getTransferHistory.tool";

export class SystemToolProviderConcrete implements ISystemToolProvider {
  constructor(
    private readonly intentUseCase: IIntentUseCase,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
    private readonly transferHistoryUseCase: ITransferHistoryUseCase | undefined,
    private readonly chainId: number,
  ) {}

  getTools(userId: string, conversationId: string): ITool[] {
    const tools: ITool[] = [
      new TransferErc20Tool(userId, conversationId, this.intentUseCase),
      new WalletBalancesTool(userId, this.walletDataProvider, this.userProfileCache),
      new TransactionStatusTool(this.walletDataProvider),
      new GasSpendTool(userId, this.walletDataProvider, this.userProfileCache),
      new RpcProxyTool(userId, this.walletDataProvider, this.userProfileCache),
    ];
    if (this.transferHistoryUseCase) {
      tools.push(new GetTransferHistoryTool(userId, this.transferHistoryUseCase, this.chainId));
    }
    return tools;
  }
}
