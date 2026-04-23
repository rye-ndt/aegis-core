import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { INTENT_ACTION } from "../../../../helpers/enums/intentAction.enum";
import type {
  IIntentParser,
  IntentPackage,
} from "../../../../use-cases/interface/output/intentParser.interface";
import type { ToolManifest } from "../../../../use-cases/interface/output/toolManifest.types";
import { WINDOW_SIZE } from "../../../../use-cases/interface/input/intent.errors";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";

const BUILTIN_ACTIONS = Object.values(INTENT_ACTION).join(" | ");
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const IntentSchema = z.object({
  action: z.string(),
  fromTokenSymbol: z.string().nullable(),
  toTokenSymbol: z.string().nullable(),
  amountHuman: z.string().nullable(),
  slippageBps: z.number().nullable(),
  recipient: z.string().nullable(),
  params: z
    .object({})
    .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .nullable(),
  confidence: z.number().min(0).max(1),
  isOnChainAction: z.boolean(),
});

const ResponseSchema = z.object({
  intent: IntentSchema.nullable(),
});

const BASE_SYSTEM_PROMPT = `You are an intent parser for a ${CHAIN_CONFIG.name} DeFi trading agent.
The user may have spread their intent across several messages — extract the combined intent from all messages.

If the user is NOT asking for any on-chain action (e.g. chatting, asking a question, greeting), return: { "intent": null }

If the user IS requesting an on-chain action, extract:
- action: one of the built-in actions (${BUILTIN_ACTIONS}) OR a dynamic toolId if applicable
- fromTokenSymbol: token the user wants to spend/send (e.g. "${CHAIN_CONFIG.nativeSymbol}", "USDC"). 
  notice that $ symbol, with no ticker will be intepreted as USDC token
- toTokenSymbol: token the user wants to receive (swaps only)
- amountHuman: human-readable amount as a string (e.g. "1.5", "100")
- slippageBps: slippage in basis points if specified; default 50 for swaps
- recipient: destination Ethereum address (0x...) if specified (transfers only)
- params: key/value pairs for dynamic tool inputs (null for built-in actions)
- confidence: 0–1 confidence in the parsed intent
- isOnChainAction: true if the user is requesting an on-chain action

Set string fields to null when they cannot be determined. Do not resolve token addresses or decimals.`;

function buildSystemPrompt(relevantManifests: ToolManifest[]): string {
  if (relevantManifests.length === 0) return BASE_SYSTEM_PROMPT;

  const toolLines = relevantManifests.map((t) => {
    const props =
      (t.inputSchema as { properties?: Record<string, unknown> }).properties ??
      {};
    const requiredInputs = Object.keys(props).join(", ");
    return `- toolId: "${t.toolId}" | [${t.protocolName}] ${t.description} | Tags: ${t.tags.join(", ")} | Required inputs: ${requiredInputs}`;
  });

  return (
    BASE_SYSTEM_PROMPT +
    "\n\nAdditionally, the following community tools are available. Set action = toolId and populate params with the required inputs to use them:\n" +
    toolLines.join("\n")
  );
}

export class OpenAIIntentParser implements IIntentParser {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
    this.model = OPENAI_MODEL;
  }

  async parse(
    messages: string[],
    _userId: string,
    relevantManifests?: ToolManifest[],
  ): Promise<IntentPackage | null> {
    const window = messages.slice(-WINDOW_SIZE);

    const userContent =
      window.length === 1
        ? window[0]!
        : window.map((m, i) => `[Message ${i + 1}]: ${m}`).join("\n");

    const systemPrompt = buildSystemPrompt(relevantManifests ?? []);

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

    if (parsed.intent === null || !parsed.intent.isOnChainAction) return null;

    const {
      action,
      fromTokenSymbol,
      toTokenSymbol,
      amountHuman,
      slippageBps,
      recipient,
      params,
      confidence,
    } = parsed.intent;
    return {
      action,
      confidence,
      rawInput: window[window.length - 1]!,
      ...(fromTokenSymbol != null && { fromTokenSymbol }),
      ...(toTokenSymbol != null && { toTokenSymbol }),
      ...(amountHuman != null && { amountHuman }),
      ...(slippageBps != null && { slippageBps }),
      ...(recipient != null && {
        recipient: recipient as IntentPackage["recipient"],
      }),
      ...(params != null && { params }),
    };
  }
}
