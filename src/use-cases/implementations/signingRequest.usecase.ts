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

/**
 * Parse the FE's transport + environment prefix on `errorRaw`:
 *   [bundler] HTTP 503 api.pimlico.io/v2 body=... {durationMs=12345 online=true vis=visible tg=ios/7.0 sca=0x…}
 * Returns structured fields when present, undefined otherwise. Read-only —
 * the FE-side writer is `buildErrorRaw` in `fe/.../extractViemErrorContext.ts`.
 */
function parseTransportTag(raw: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const head = raw.match(/^\[(bundler|paymaster|rpc|unknown)\](?:\s+HTTP\s+(\d+))?(?:\s+([^\s\n{]+))?/);
  if (head) {
    out.failKind = head[1];
    if (head[2]) out.failStatus = Number(head[2]);
    if (head[3]) out.failEndpoint = head[3];
  }
  const lastRpc = raw.match(/^lastRpc=(.+)$/m);
  if (lastRpc && lastRpc[1]) {
    out.failLastRpc = lastRpc[1].trim();
  }
  const env = raw.match(/\{([^}\n]+)\}/);
  if (env && env[1]) {
    for (const pair of env[1].split(/\s+/)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      if (k === "durationMs") {
        const n = Number(v);
        if (Number.isFinite(n)) out.failDurationMs = n;
      } else if (k === "online") {
        out.failOnline = v === "true";
      } else if (k === "vis") {
        out.failVisibility = v;
      } else if (k === "tg") {
        out.failTgPlatform = v;
      } else if (k === "sca") {
        out.failSca = v;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
// How long a successfully-claimed txHash blocks a different requestId from
// re-claiming it. The FE's localStorage dedupe TTL is 10 min; pairing this
// guard at the same window catches the cross-requestId reuse scenario:
// the FE silently reusing an old hash (because legacy payload-keyed
// dedupe matched) would otherwise fake a second success card. 10 min is
// also longer than the signing request TTL (10 min) so any hash from a
// still-resolvable request is also covered.
const RECENT_TXHASH_TTL_MS = 10 * 60 * 1000;

export class SigningRequestUseCaseImpl implements ISigningRequestUseCase {
  // Per-request cancel hooks installed by `waitFor`. Calling the fn flips the
  // poll loop into `expired` on its next iteration (or sooner — the loop also
  // races a cancel-promise so the await unblocks immediately).
  private readonly cancelByRequestId = new Map<string, () => void>();
  // Reverse index so `cancelActiveForUser` can find every in-flight requestId
  // for a user without scanning the whole map.
  private readonly requestsByUserId = new Map<string, Set<string>>();
  // Per-user recent successful txHashes. Used to reject a /response that
  // claims a txHash already consumed by a *different* requestId — i.e. the
  // FE silently reusing a stale hash from its localStorage dedupe cache.
  // Keyed by userId, then by lowercased txHash.
  private readonly recentTxHashByUser = new Map<
    string,
    Map<string, { requestId: string; ts: number }>
  >();

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
    // A record can be flipped to `expired` *before* its `expiresAt` by
    // `cancelPendingForUser` when a newer user input supersedes the dispatch
    // that created it. Without this guard a late /response would still flip
    // it to approved/rejected and `notifyResolved` would render a phantom
    // success/failure card for a request the user has already moved on from.
    if (record.status !== "pending") {
      log.info(
        {
          step: "resolve-on-non-pending",
          requestId: params.requestId,
          status: record.status,
        },
        "ignoring late /response on already-terminal signing request",
      );
      throw new Error("SIGNING_REQUEST_EXPIRED");
    }

    const rejected = params.rejected === true;

    // Reject hash reuse: a different requestId for the same user already
    // claimed this txHash recently, which means the FE handed us a stale
    // hash from its dedupe cache rather than broadcasting fresh. Without
    // this guard we'd render a phantom success card for a tx the user
    // never re-signed.
    if (!rejected && params.txHash) {
      const hashKey = params.txHash.toLowerCase();
      const guard = this.checkAndRecordTxHash(record.userId, hashKey, params.requestId);
      if (!guard.ok) {
        log.warn(
          {
            step: "duplicate-txhash-rejected",
            requestId: params.requestId,
            priorRequestId: guard.priorRequestId,
            userId: record.userId,
            hash: hashKey,
            ageMs: guard.ageMs,
          },
          "FE submitted a txHash already consumed by another requestId",
        );
        throw new Error("SIGNING_REQUEST_DUPLICATE_HASH");
      }
    }

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
      // The FE prefixes errorRaw with `[<kind>] HTTP <status> <endpoint>` for
      // transport-class failures (see fe extractViemErrorContext.ts) — parse
      // it back into structured fields so log filters don't have to regex.
      const transportTag = parseTransportTag(params.errorRaw);
      log.warn(
        {
          step: "signing-request-rejected-raw",
          requestId: params.requestId,
          userId: params.userId,
          errorCode: params.errorCode,
          ...(transportTag ?? {}),
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
      requestId: record.id,
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
      silentResolution: record.silentResolution,
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

  /**
   * Returns ok=true if the (userId, txHash) pair is fresh OR already owned
   * by the same requestId (the latter keeps repeated /response calls for the
   * same request idempotent — e.g. the FE retrying after a flaky network).
   * Returns ok=false when a *different* recent requestId already claimed
   * this hash, indicating stale-hash reuse.
   *
   * On ok=true the entry is recorded so subsequent attempts are caught.
   */
  private checkAndRecordTxHash(
    userId: string,
    hashKey: string,
    requestId: string,
  ): { ok: true } | { ok: false; priorRequestId: string; ageMs: number } {
    const now = Date.now();
    let bucket = this.recentTxHashByUser.get(userId);
    if (bucket) {
      // Prune entries past TTL to keep memory bounded without a global timer.
      for (const [k, v] of bucket) {
        if (now - v.ts > RECENT_TXHASH_TTL_MS) bucket.delete(k);
      }
    }
    const existing = bucket?.get(hashKey);
    if (existing) {
      if (existing.requestId === requestId) return { ok: true }; // idempotent retry
      return {
        ok: false,
        priorRequestId: existing.requestId,
        ageMs: now - existing.ts,
      };
    }
    if (!bucket) {
      bucket = new Map();
      this.recentTxHashByUser.set(userId, bucket);
    }
    bucket.set(hashKey, { requestId, ts: now });
    return { ok: true };
  }

  async cancelPendingForUser(userId: string): Promise<number> {
    // Cache flip first, in-process cancel second. Order matters: a still-
    // running `waitFor` polls the cache, so flipping the record first means
    // the very next poll tick observes `status === 'expired'` and unwinds —
    // even if the in-process cancel signal somehow doesn't reach it.
    const cancelledIds = await this.cache.cancelPendingForUser(userId);
    const inProcessCount = this.cancelActiveForUser(userId);
    if (cancelledIds.length > 0 || inProcessCount > 0) {
      log.info(
        {
          step: "supersede-user",
          userId,
          cacheCount: cancelledIds.length,
          inProcessCount,
        },
        "superseded user's pending signing requests",
      );
    }
    return cancelledIds.length;
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
