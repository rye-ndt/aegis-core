import type { ITool } from "../../../use-cases/interface/output/tool.interface";
import type { ISystemToolProvider } from "../../../use-cases/interface/output/systemToolProvider.interface";
import type { IWalletDataProvider } from "../../../use-cases/interface/output/walletDataProvider.interface";
import type { IUserProfileCache } from "../../../use-cases/interface/output/cache/userProfile.cache";
import type { ITransferHistoryUseCase } from "../../../use-cases/interface/input/transferHistory.interface";
import { TransactionStatusTool } from "./tools/system/transactionStatus.tool";
import { GetTransferHistoryTool } from "./tools/getTransferHistory.tool";

export class SystemToolProviderConcrete implements ISystemToolProvider {
  constructor(
    private readonly walletDataProvider: IWalletDataProvider,
    private readonly userProfileCache: IUserProfileCache | undefined,
    private readonly transferHistoryUseCase: ITransferHistoryUseCase | undefined,
    private readonly chainId: number,
  ) {}

  getTools(userId: string, _conversationId: string): ITool[] {
    const tools: ITool[] = [
      new TransactionStatusTool(this.walletDataProvider),
    ];
    if (this.transferHistoryUseCase) {
      tools.push(new GetTransferHistoryTool(userId, this.transferHistoryUseCase, this.chainId));
    }
    return tools;
  }
}
