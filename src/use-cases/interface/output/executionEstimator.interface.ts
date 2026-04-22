// BE 11 + 12: IExecutionEstimator interface and EstimationResultSchema (Zod)

import { z } from 'zod';

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

export interface IExecutionEstimator {
  estimate(input: EstimationInput): Promise<EstimationResult>;
}
