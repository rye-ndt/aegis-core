import { createLogger } from "../../helpers/observability/logger";
import { newUuid } from "../../helpers/uuid";
import type {
  GetHistoryInput,
  ITransferHistoryUseCase,
} from "../interface/input/transferHistory.interface";
import type {
  ITransferHistoryProvider,
  TransferHistoryPage,
  TransferRecord,
} from "../interface/output/blockchain/transferHistoryProvider.interface";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IIntentExecutionDB } from "../interface/output/repository/intentExecution.repo";

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
    /**
     * Optional — when present, transfers whose `txHash` matches an Aegis
     * intent execution row are tagged with `label` (e.g. "swap via RelaySwap").
     * Failures are logged but never block history delivery.
     */
    private readonly intentExecutionDB?: IIntentExecutionDB,
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

      const enriched = await this.enrichWithLabels(input.userId, page.items);

      log.info(
        {
          step: "succeeded",
          userId: input.userId,
          requestId,
          count: enriched.length,
          durationMs: Date.now() - start,
        },
        "history-served",
      );
      return { items: enriched, nextCursor: page.nextCursor };
    } catch (err) {
      log.error(
        { err, userId: input.userId, requestId, step: "failed", durationMs: Date.now() - start },
        "history-failed",
      );
      throw err;
    }
  }

  /**
   * Best-effort enrichment: look up Aegis intent executions by tx hash and
   * attach a `label` to matching rows. Skipped silently when the repo isn't
   * wired or when the lookup fails — never blocks history delivery.
   */
  private async enrichWithLabels(
    userId: string,
    items: TransferRecord[],
  ): Promise<TransferRecord[]> {
    if (!this.intentExecutionDB || items.length === 0) return items;
    const txHashes = Array.from(new Set(items.map((i) => i.txHash.toLowerCase())));
    let executions;
    try {
      executions = await this.intentExecutionDB.findByTxHashes(userId, txHashes);
    } catch (err) {
      log.warn({ err, userId, count: txHashes.length }, "label-enrich-failed");
      return items;
    }
    if (executions.length === 0) return items;

    const labelByTxHash = new Map<string, string>();
    for (const e of executions) {
      if (!e.txHash) continue;
      labelByTxHash.set(e.txHash.toLowerCase(), buildLabel(e.solverUsed));
    }

    return items.map((it) => {
      const label = labelByTxHash.get(it.txHash.toLowerCase());
      return label ? { ...it, label } : it;
    });
  }
}

/**
 * Convert the raw `solverUsed` identifier into a short user-facing label.
 * Stable across solver renames is not a requirement here — the LLM/FE just
 * surfaces the string verbatim, and an unrecognised solver yields a generic
 * "via <solverUsed>" line.
 */
function buildLabel(solverUsed: string): string {
  const lower = solverUsed.toLowerCase();
  if (lower.includes("relayswap") || lower.includes("relay")) return "swap via Relay";
  if (lower.includes("swap")) return `swap via ${solverUsed}`;
  if (lower.includes("yield") || lower.includes("aave")) return `yield via ${solverUsed}`;
  if (lower.includes("send") || lower.includes("transfer")) return "send";
  if (lower.includes("claim")) return "rewards claim";
  return `via ${solverUsed}`;
}

