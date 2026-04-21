import type { ITool } from "../../../use-cases/interface/output/tool.interface";
import type { ISystemToolProvider } from "../../../use-cases/interface/output/systemToolProvider.interface";
import type { IWalletDataProvider } from "../../../use-cases/interface/output/walletDataProvider.interface";
import type { IIntentUseCase } from "../../../use-cases/interface/input/intent.interface";
import type { IUserProfileCache } from "../../../use-cases/interface/output/cache/userProfile.cache";
import { TransferErc20Tool } from "./tools/system/transferErc20.tool";
import { WalletBalancesTool } from "./tools/system/walletBalances.tool";
import { TransactionStatusTool } from "./tools/system/transactionStatus.tool";
import { GasSpendTool } from "./tools/system/gasSpend.tool";
import { RpcProxyTool } from "./tools/system/rpcProxy.tool";

export class SystemToolProviderConcrete implements ISystemToolProvider {
  constructor(
    private readonly intentUseCase: IIntentUseCase,
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
  ) {}

  getTools(userId: string, conversationId: string): ITool[] {
    return [
      new TransferErc20Tool(userId, conversationId, this.intentUseCase),
      new WalletBalancesTool(userId, this.walletDataProvider, this.userProfileCache),
      new TransactionStatusTool(this.walletDataProvider),
      new GasSpendTool(userId, this.walletDataProvider, this.userProfileCache),
      new RpcProxyTool(userId, this.walletDataProvider, this.userProfileCache),
    ];
  }
}
