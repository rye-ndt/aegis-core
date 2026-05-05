import { z } from "zod";
import { newCurrentUTCEpoch } from "./time/dateTime";

export interface EstimationInput {
  delegations: {
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    limitRaw: string;
    spentRaw: string;
    validUntil: number; // unix epoch seconds
  }[];
  intentTokenAddress: string;
  intentTokenSymbol: string;
  intentAmountRaw: string;
  intentAmountHuman: string;
}

export interface EstimationResult {
  shouldApproveMore: boolean;
  displayMessage: string;
  tokenAddress: string | null;
  humanReadableAmount: string | null;
}

export const EstimationResultSchema = z.object({
  shouldApproveMore: z.boolean(),
  displayMessage: z.string(),
  tokenAddress: z.string().nullable(),
  humanReadableAmount: z.string().nullable(),
});

/**
 * Aegis-Guard pre-execution check: given the user's active token delegations
 * and the intent's token+amount, decide whether the existing spending limit
 * suffices or the user must approve more first.
 *
 * Pure function — no I/O, deterministic. Was previously the sole impl of
 * `IExecutionEstimator`; the port was collapsed in the 2026-05-05 cleanup
 * (no second impl planned).
 */
export function estimateExecution(input: EstimationInput): EstimationResult {
  const now = newCurrentUTCEpoch();
  const normalizedIntentAddress = input.intentTokenAddress.toLowerCase();

  const delegation = input.delegations.find((d) => {
    if (d.validUntil <= now) return false;
    const addressMatch = d.tokenAddress.toLowerCase() === normalizedIntentAddress;
    const symbolMatch = d.tokenSymbol.toUpperCase() === input.intentTokenSymbol.toUpperCase();
    return addressMatch || symbolMatch;
  });

  if (!delegation) {
    return {
      shouldApproveMore: true,
      displayMessage: `No active spending limit found for ${input.intentTokenSymbol}. Please approve a spending limit first.`,
      tokenAddress: normalizedIntentAddress,
      humanReadableAmount: null,
    };
  }

  const limit = BigInt(delegation.limitRaw);
  const spent = BigInt(delegation.spentRaw);
  const intentAmount = BigInt(input.intentAmountRaw || "0");
  const remaining = limit - spent;

  if (remaining < intentAmount) {
    const suggestedTopUp = Math.max(parseFloat(input.intentAmountHuman || "0"), 100);
    return {
      shouldApproveMore: true,
      displayMessage: `Your spending limit for ${input.intentTokenSymbol} is exhausted. Please approve more.`,
      tokenAddress: delegation.tokenAddress,
      humanReadableAmount: suggestedTopUp.toString(),
    };
  }

  return {
    shouldApproveMore: false,
    displayMessage: `Executing ${input.intentAmountHuman} ${input.intentTokenSymbol} transfer...`,
    tokenAddress: null,
    humanReadableAmount: null,
  };
}
