import { createLogger } from "../../helpers/observability/logger";
import { newUuid } from "../../helpers/uuid";
import type {
  GetHistoryInput,
  ITransferHistoryUseCase,
} from "../interface/input/transferHistory.interface";
import type {
  ITransferHistoryProvider,
  TransferHistoryPage,
} from "../interface/output/blockchain/transferHistoryProvider.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";

const log = createLogger("transferHistoryUseCase");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export type TransferHistoryProviderFactory = (
  userId: string,
) => ITransferHistoryProvider;

export class TransferHistoryUseCaseImpl implements ITransferHistoryUseCase {
  constructor(
    private readonly userProfileDB: IUserProfileDB,
    private readonly providerFactory: TransferHistoryProviderFactory,
    private readonly chainId: number,
  ) {}

  async getHistory(input: GetHistoryInput): Promise<TransferHistoryPage> {
    const requestId = newUuid().slice(0, 8);
    const start = Date.now();
    log.info(
      {
        step: "started",
        userId: input.userId,
        requestId,
        chainId: this.chainId,
        direction: input.direction,
        fromEpoch: input.fromEpoch,
        toEpoch: input.toEpoch,
      },
      "history-request",
    );

    try {
      const profile = await this.userProfileDB.findByUserId(input.userId);
      if (!profile?.smartAccountAddress) {
        log.info(
          { step: "succeeded", userId: input.userId, requestId, count: 0, reason: "no-sca" },
          "history-empty",
        );
        return { items: [], nextCursor: null };
      }

      const limit = Math.min(
        Math.max(1, input.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT,
      );

      const provider = this.providerFactory(input.userId);
      const page = await provider.getHistory({
        chainId: this.chainId,
        address: profile.smartAccountAddress as `0x${string}`,
        fromEpoch: input.fromEpoch,
        toEpoch: input.toEpoch,
        direction: input.direction,
        limit,
        cursor: input.cursor,
      });

      log.info(
        {
          step: "succeeded",
          userId: input.userId,
          requestId,
          count: page.items.length,
          durationMs: Date.now() - start,
        },
        "history-served",
      );
      return page;
    } catch (err) {
      log.error(
        { err, userId: input.userId, requestId, step: "failed", durationMs: Date.now() - start },
        "history-failed",
      );
      throw err;
    }
  }
}
