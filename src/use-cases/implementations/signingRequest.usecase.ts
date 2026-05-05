import { createLogger } from "../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import type {
  ISigningRequestUseCase,
  SigningResolutionEvent,
} from "../interface/input/signingRequest.interface";
import type {
  ISigningRequestCache,
  ResolvedSigningRequest,
  SigningRequestRecord,
} from "../interface/output/cache/signingRequest.cache";
import type { ITokenDelegationDB } from "../interface/output/repository/tokenDelegation.repo";

const log = createLogger("signingRequest");
const POLL_INTERVAL_MS = 1500;

export class SigningRequestUseCaseImpl implements ISigningRequestUseCase {
  // Per-request cancel hooks installed by `waitFor`. Calling the fn flips the
  // poll loop into `expired` on its next iteration (or sooner — the loop also
  // races a cancel-promise so the await unblocks immediately).
  private readonly cancelByRequestId = new Map<string, () => void>();
  // Reverse index so `cancelActiveForUser` can find every in-flight requestId
  // for a user without scanning the whole map.
  private readonly requestsByUserId = new Map<string, Set<string>>();

  constructor(
    private readonly cache: ISigningRequestCache,
    private readonly onResolved: (event: SigningResolutionEvent) => void,
    private readonly tokenDelegationDB?: ITokenDelegationDB,
  ) {}

  async create(record: SigningRequestRecord): Promise<void> {
    await this.cache.save(record);
    log.info(
      {
        step: "signing-request-created",
        requestId: record.id,
        userId: record.userId,
      },
      "signing request created",
    );
  }

  async resolveRequest(params: {
    requestId: string;
    userId: string;
    txHash?: string;
    rejected?: boolean;
    errorCode?: string;
    errorMessage?: string;
    errorRaw?: string;
  }): Promise<void> {
    const record = await this.cache.findById(params.requestId);
    if (!record) throw new Error("SIGNING_REQUEST_NOT_FOUND");
    if (record.userId !== params.userId)
      throw new Error("SIGNING_REQUEST_FORBIDDEN");

    const now = newCurrentUTCEpoch();
    if (record.expiresAt <= now) throw new Error("SIGNING_REQUEST_EXPIRED");

    const rejected = params.rejected === true;
    await this.cache.resolve(
      params.requestId,
      rejected ? "rejected" : "approved",
      params.txHash,
      params.errorCode,
      params.errorMessage,
    );
    log.info(
      {
        step: "signing-request-resolved",
        requestId: params.requestId,
        rejected,
        hasTxHash: !!params.txHash,
        errorCode: params.errorCode,
      },
      "signing request resolved",
    );
    if (rejected && params.errorRaw) {
      // Surface the raw on-chain revert reason at warn so failures with
      // errorCode='unknown' are still investigable from logs alone.
      log.warn(
        {
          step: "signing-request-rejected-raw",
          requestId: params.requestId,
          userId: params.userId,
          errorCode: params.errorCode,
          errorRaw: params.errorRaw,
        },
        "client-reported sign error",
      );
    }

    if (
      !rejected &&
      this.tokenDelegationDB &&
      record.tokenAddress &&
      record.amountRaw
    ) {
      try {
        await this.tokenDelegationDB.addSpent(
          record.userId,
          record.tokenAddress,
          record.amountRaw,
        );
        log.debug(
          {
            step: "spent-recorded",
            requestId: params.requestId,
            userId: record.userId,
          },
          "delegation spent_raw incremented",
        );
      } catch (err) {
        log.error(
          { err, requestId: params.requestId, userId: record.userId },
          "addSpent failed",
        );
      }
    }

    this.onResolved({
      chatId: record.chatId,
      userId: record.userId,
      txHash: params.txHash,
      rejected,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      data: record.data,
      to: record.to,
      recipientTelegramUserId: record.recipientTelegramUserId,
      recipientHandle: record.recipientHandle,
      amountFormatted: record.amountFormatted,
      tokenSymbol: record.tokenSymbol,
      planKind: record.planKind,
    });
  }

  async waitFor(
    requestId: string,
    timeoutMs: number,
  ): Promise<ResolvedSigningRequest> {
    const deadline = Date.now() + timeoutMs;
    log.debug(
      { choice: "waitFor-start", requestId, timeoutMs },
      "waiting for signing request",
    );

    // Install a cancel hook indexed by both requestId and userId. The userId
    // index lets the Telegram input adapter break the poll when a fresh user
    // command arrives, instead of letting grammy's per-chat queue stall behind
    // a 10-minute waitFor.
    let cancelled = false;
    let cancelResolve: () => void = () => {};
    const cancelPromise = new Promise<void>((resolve) => {
      cancelResolve = resolve;
    });
    const cancelFn = () => {
      cancelled = true;
      cancelResolve();
    };
    this.cancelByRequestId.set(requestId, cancelFn);

    // Resolve userId from the cache once for indexing. If the record is
    // already gone, fall through to the loop's "not found" branch.
    let indexedUserId: string | undefined;
    try {
      const initial = await this.cache.findById(requestId);
      if (initial) {
        indexedUserId = initial.userId;
        if (!this.requestsByUserId.has(indexedUserId)) {
          this.requestsByUserId.set(indexedUserId, new Set());
        }
        this.requestsByUserId.get(indexedUserId)!.add(requestId);
      }
    } catch {
      // Ignore — the loop below will retry and surface the proper error.
    }

    try {
      while (Date.now() < deadline) {
        if (cancelled) {
          log.info(
            { step: "waitFor-cancelled", requestId, userId: indexedUserId },
            "waitFor cancelled by new user command",
          );
          return { status: "expired" };
        }
        const record = await this.cache.findById(requestId);
        if (!record) {
          log.info(
            { step: "waitFor-expired", requestId },
            "signing request not found — expired",
          );
          return { status: "expired" };
        }
        if (record.status === "approved") {
          log.info(
            { step: "waitFor-approved", requestId },
            "signing request approved",
          );
          return { status: "approved", txHash: record.txHash };
        }
        if (record.status === "rejected") {
          log.info(
            { step: "waitFor-rejected", requestId, errorCode: record.errorCode },
            "signing request rejected",
          );
          return {
            status: "rejected",
            errorCode: record.errorCode,
            errorMessage: record.errorMessage,
          };
        }
        if (record.status === "expired") {
          log.info(
            { step: "waitFor-expired", requestId },
            "signing request expired",
          );
          return { status: "expired" };
        }
        if (record.expiresAt <= newCurrentUTCEpoch()) {
          log.info(
            { step: "waitFor-timeout", requestId },
            "signing request past expiresAt",
          );
          return { status: "expired" };
        }
        // Race the poll-tick sleep with the cancel signal so cancellation is
        // observed within ms instead of waiting up to POLL_INTERVAL_MS.
        await Promise.race([sleep(POLL_INTERVAL_MS), cancelPromise]);
      }
      log.info(
        { step: "waitFor-timeout", requestId, timeoutMs },
        "waitFor timed out",
      );
      return { status: "expired" };
    } finally {
      this.cancelByRequestId.delete(requestId);
      if (indexedUserId) {
        const set = this.requestsByUserId.get(indexedUserId);
        if (set) {
          set.delete(requestId);
          if (set.size === 0) this.requestsByUserId.delete(indexedUserId);
        }
      }
    }
  }

  cancelActiveForUser(userId: string): number {
    const ids = this.requestsByUserId.get(userId);
    if (!ids || ids.size === 0) return 0;
    let cancelled = 0;
    // Snapshot the set — `cancelFn` runs the waitFor finalizer which mutates
    // the same set, so iterating directly would skip entries.
    for (const id of Array.from(ids)) {
      const fn = this.cancelByRequestId.get(id);
      if (fn) {
        fn();
        cancelled++;
      }
    }
    if (cancelled > 0) {
      log.info(
        { step: "cancel-active-for-user", userId, cancelled },
        "cancelled in-flight waitFor for user",
      );
    }
    return cancelled;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
