import type {
  EstimationInput,
  EstimationResult,
  IExecutionEstimator,
} from '../../../../use-cases/interface/output/executionEstimator.interface';
import { newCurrentUTCEpoch } from '../../../../helpers/time/dateTime';

export class DeterministicExecutionEstimator implements IExecutionEstimator {
  async estimate(input: EstimationInput): Promise<EstimationResult> {
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
    const intentAmount = BigInt(input.intentAmountRaw || '0');
    const remaining = limit - spent;

    if (remaining < intentAmount) {
      const suggestedTopUp = Math.max(parseFloat(input.intentAmountHuman || '0'), 100);
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
}
