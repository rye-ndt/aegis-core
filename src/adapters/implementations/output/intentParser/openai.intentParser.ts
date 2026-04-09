import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { INTENT_ACTION } from "../../../../helpers/enums/intentAction.enum";
import type {
  IIntentParser,
  IntentPackage,
} from "../../../../use-cases/interface/output/intentParser.interface";
import { WINDOW_SIZE } from "./intent.validator";

const IntentSchema = z.object({
  action: z.enum([
    INTENT_ACTION.SWAP,
    INTENT_ACTION.STAKE,
    INTENT_ACTION.UNSTAKE,
    INTENT_ACTION.CLAIM_REWARDS,
    INTENT_ACTION.TRANSFER,
    INTENT_ACTION.UNKNOWN,
  ]),
  fromTokenSymbol: z.string().nullable(),
  toTokenSymbol: z.string().nullable(),
  amountHuman: z.string().nullable(),
  slippageBps: z.number().nullable(),
  recipient: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

const ResponseSchema = z.object({
  intent: IntentSchema.nullable(),
});

const systemPrompt = `You are an intent parser for an Avalanche DeFi trading agent.
The user may have spread their intent across several messages — extract the combined intent from all messages.

If the user is NOT asking for any on-chain action (e.g. chatting, asking a question, greeting), return: { "intent": null }

If the user IS requesting an on-chain action, extract:
- action: swap | stake | unstake | claim_rewards | transfer | unknown
- fromTokenSymbol: token the user wants to spend/send (e.g. "AVAX", "USDC")
- toTokenSymbol: token the user wants to receive (swaps only)
- amountHuman: human-readable amount as a string (e.g. "1.5", "100")
- slippageBps: slippage in basis points if specified; default 50 for swaps
- recipient: destination Ethereum address (0x...) if specified (transfers only)
- confidence: 0–1 confidence in the parsed intent

Set fields to null when they cannot be determined. Do not resolve token addresses or decimals.`;

export class OpenAIIntentParser implements IIntentParser {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }

  async parse(messages: string[], _userId: string): Promise<IntentPackage | null> {
    const window = messages.slice(-WINDOW_SIZE);

    const userContent =
      window.length === 1
        ? window[0]
        : window.map((m, i) => `[Message ${i + 1}]: ${m}`).join("\n");

    const response = await this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: zodResponseFormat(ResponseSchema, "response"),
    });

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) throw new Error("No parsed response from OpenAI");

    console.log("[OpenAIIntentParser] parsed:", parsed);

    if (parsed.intent === null) return null;

    const { action, fromTokenSymbol, toTokenSymbol, amountHuman, slippageBps, recipient, confidence } = parsed.intent;
    return {
      action: action as INTENT_ACTION,
      confidence,
      rawInput: window[window.length - 1],
      ...(fromTokenSymbol != null && { fromTokenSymbol }),
      ...(toTokenSymbol != null && { toTokenSymbol }),
      ...(amountHuman != null && { amountHuman }),
      ...(slippageBps != null && { slippageBps }),
      ...(recipient != null && { recipient: recipient as IntentPackage["recipient"] }),
    };
  }
}
