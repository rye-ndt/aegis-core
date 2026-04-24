import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import type { ITokenRecord } from "../interface/input/intent.interface";
import type { ApproveRequest } from "../interface/output/cache/miniAppRequest.types";
import type { IExecutionEstimator } from "../interface/output/executionEstimator.interface";
import type { ITokenDelegationDB } from "../interface/output/repository/tokenDelegation.repo";

/**
 * Shared Aegis Guard delegation check used by both `/send` and `/swap`.
 *
 * Given a spend intent (token + human/raw amount), it asks the
 * `IExecutionEstimator` whether the user's active `token_delegations` already
 * cover this spend. When coverage is sufficient the caller may proceed with
 * autonomous signing; otherwise this helper mints a re-approval
 * `ApproveRequest` for the mini app and returns it with an explanatory
 * message.
 */
export interface AegisGuardCheckParams {
  userId: string;
  fromToken: ITokenRecord;
  amountHuman: string;
  amountRaw: string;
  tokenDelegationDB: ITokenDelegationDB;
  executionEstimator: IExecutionEstimator;
}

export type AegisGuardResult =
  | { ok: true }
  | { ok: false; reapprovalRequest: ApproveRequest; displayMessage: string };

/** Upper bound used when minting a reapproval — see §6 of relay-swap-plan. */
const REAPPROVAL_FLOOR_HUMAN = 100;
const REAPPROVAL_TTL_SECONDS = 600;

export async function checkTokenDelegation(
  params: AegisGuardCheckParams,
): Promise<AegisGuardResult> {
  const { userId, fromToken, amountHuman, amountRaw } = params;

  const delegations = await params.tokenDelegationDB.findActiveByUserId(userId);
  const estimation = await params.executionEstimator.estimate({
    delegations,
    intentTokenAddress: fromToken.address,
    intentTokenSymbol: fromToken.symbol,
    intentAmountRaw: amountRaw,
    intentAmountHuman: amountHuman,
  });

  if (!estimation.shouldApproveMore) return { ok: true };

  const humanAsNum = parseFloat(amountHuman);
  const topUpHuman = Math.max(isFinite(humanAsNum) ? humanAsNum : 0, REAPPROVAL_FLOOR_HUMAN);
  const rawForReapproval = (
    BigInt(Math.round(topUpHuman)) * 10n ** BigInt(fromToken.decimals)
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

  return { ok: false, reapprovalRequest, displayMessage: estimation.displayMessage };
}
