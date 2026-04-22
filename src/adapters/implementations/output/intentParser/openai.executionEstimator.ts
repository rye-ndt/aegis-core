// BE 13: OpenAI-backed IExecutionEstimator
// Uses strict JSON schema output to check if a user has sufficient delegation
// capacity before the bot autonomously executes a transaction.

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type {
  EstimationInput,
  EstimationResult,
  IExecutionEstimator,
} from '../../../../use-cases/interface/output/executionEstimator.interface';
import { EstimationResultSchema } from '../../../../use-cases/interface/output/executionEstimator.interface';

const SYSTEM_PROMPT_TEMPLATE = (now: number) => `\
You are a spending-limit checker for a DeFi trading bot.
Given a list of token delegations (each with limitRaw, spentRaw, validUntil in unix seconds)
and a proposed spend (intentTokenSymbol, intentAmountRaw, intentAmountHuman), determine:

1. Does an active (validUntil > ${now}), non-expired delegation exist for the exact token \
(match by intentTokenAddress or intentTokenSymbol)?
2. Is remaining capacity (limitRaw - spentRaw) >= intentAmountRaw?

If BOTH conditions are met → shouldApproveMore = false, displayMessage = brief neutral \
confirmation (e.g. "Executing 5 USDC transfer...").
Otherwise → shouldApproveMore = true, displayMessage = friendly explanation of what is needed \
(e.g. "Your spending limit for USDC is exhausted. Please approve more."), \
tokenAddress = the address of the blocking token, \
humanReadableAmount = suggested top-up in human-readable units (use a round number ≥ intentAmountHuman).

Current unix timestamp: ${now}.
Respond ONLY with valid JSON matching the schema — no prose, no markdown.`;

export class OpenAIExecutionEstimator implements IExecutionEstimator {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }

  async estimate(input: EstimationInput): Promise<EstimationResult> {
    const now = Math.floor(Date.now() / 1000);

    const userContent = JSON.stringify({
      delegations: input.delegations,
      intentTokenAddress: input.intentTokenAddress,
      intentTokenSymbol: input.intentTokenSymbol,
      intentAmountRaw: input.intentAmountRaw,
      intentAmountHuman: input.intentAmountHuman,
    });

    const response = await this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_TEMPLATE(now) },
        { role: 'user', content: userContent },
      ],
      response_format: zodResponseFormat(EstimationResultSchema, 'result'),
    });

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) throw new Error('[ExecutionEstimator] No parsed response from OpenAI');

    console.log('[ExecutionEstimator] result:', parsed);
    return parsed;
  }
}
