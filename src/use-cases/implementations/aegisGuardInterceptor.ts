import { DELEGATION_ENV } from "../../helpers/env/delegationEnv";
import { estimateExecution } from "../../helpers/executionEstimator";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { createLogger } from "../../helpers/observability/logger";
import type { ITokenRecord } from "../interface/input/intent.interface";
import type { ApproveRequest } from "../interface/output/cache/miniAppRequest.types";
import type { ITokenDelegationDB } from "../interface/output/repository/tokenDelegation.repo";

const log = createLogger("aegisGuardInterceptor");

/**
 * Shared Aegis Guard delegation check used by both `/send` and `/swap`.
 *
 * Given a spend intent (token + human/raw amount), it runs `estimateExecution`
 * to check whether the user's active `token_delegations` already cover this
 * spend. When coverage is sufficient the caller may proceed with autonomous
 * signing; otherwise this helper mints a re-approval `ApproveRequest`.
 *
 * `amountRaw` on the request is `intentRaw × NON_STABLE_REAPPROVAL_MULTIPLIER`.
 * The BE `/delegation/approval-params` endpoint owns mode selection: for
 * stable tokens it ignores this value and returns env-pinned caps for both
 * USDC and USDT; for non-stables it returns just the failing token at this
 * amount.
 */
export interface AegisGuardCheckParams {
  userId: string;
  fromToken: ITokenRecord;
  amountHuman: string;
  amountRaw: string;
  tokenDelegationDB: ITokenDelegationDB;
}

export type AegisGuardResult =
  | { ok: true }
  | { ok: false; reapprovalRequest: ApproveRequest; displayMessage: string };

const REAPPROVAL_TTL_SECONDS = 600;

export async function checkTokenDelegation(
  params: AegisGuardCheckParams,
): Promise<AegisGuardResult> {
  const { userId, fromToken, amountHuman, amountRaw } = params;

  const delegations = await params.tokenDelegationDB.findActiveByUserId(userId);
  const estimation = estimateExecution({
    delegations,
    intentTokenAddress: fromToken.address,
    intentTokenSymbol: fromToken.symbol,
    intentAmountRaw: amountRaw,
    intentAmountHuman: amountHuman,
  });

  if (!estimation.shouldApproveMore) return { ok: true };

  const intentRaw = BigInt(amountRaw || "0");
  const rawForReapproval = (
    intentRaw * BigInt(DELEGATION_ENV.nonStableReapprovalMultiplier)
  ).toString();

  const now = newCurrentUTCEpoch();
  const reapprovalRequest: ApproveRequest = {
    requestId: newUuid(),
    requestType: "approve",
    userId,
    subtype: "aegis_guard",
    createdAt: now,
    expiresAt: now + REAPPROVAL_TTL_SECONDS,
    reapproval: true,
    tokenAddress: fromToken.address,
    amountRaw: rawForReapproval,
  };

  log.info(
    { step: "reapproval-minted", userId, tokenSymbol: fromToken.symbol },
    "aegis-guard reapproval request minted",
  );

  return { ok: false, reapprovalRequest, displayMessage: estimation.displayMessage };
}
