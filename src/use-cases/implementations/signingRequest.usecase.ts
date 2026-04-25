import { createLogger } from "../../helpers/observability/logger";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import type { ISigningRequestUseCase } from "../interface/input/signingRequest.interface";
import type {
  ISigningRequestCache,
  ResolvedSigningRequest,
  SigningRequestRecord,
} from "../interface/output/cache/signingRequest.cache";

const log = createLogger("signingRequest");
const POLL_INTERVAL_MS = 1500;

export class SigningRequestUseCaseImpl implements ISigningRequestUseCase {
  constructor(
    private readonly cache: ISigningRequestCache,
    private readonly onResolved: (
      chatId: number,
      txHash: string | undefined,
      rejected: boolean,
    ) => void,
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
    );
    log.info(
      {
        step: "signing-request-resolved",
        requestId: params.requestId,
        rejected,
        hasTxHash: !!params.txHash,
      },
      "signing request resolved",
    );

    this.onResolved(record.chatId, params.txHash, rejected);
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
    while (Date.now() < deadline) {
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
          { step: "waitFor-rejected", requestId },
          "signing request rejected",
        );
        return { status: "rejected" };
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
      await sleep(POLL_INTERVAL_MS);
    }
    log.info(
      { step: "waitFor-timeout", requestId, timeoutMs },
      "waitFor timed out",
    );
    return { status: "expired" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
