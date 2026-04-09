import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { IIntentParser, IntentPackage } from "../../../../use-cases/interface/output/intentParser.interface";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";

const IntentPackageSchema = z.object({
  action: z.enum(["swap", "stake", "unstake", "claim_rewards", "transfer", "unknown"]),
  tokenIn: z
    .object({
      symbol: z.string(),
      address: z.string(),
      decimals: z.number(),
      amountHuman: z.string(),
      amountRaw: z.string(),
    })
    .optional(),
  tokenOut: z
    .object({
      symbol: z.string(),
      address: z.string(),
      decimals: z.number(),
    })
    .optional(),
  slippageBps: z.number().optional(),
  recipient: z.string().optional(),
  confidence: z.number().min(0).max(1),
  rawInput: z.string(),
});

export class AnthropicIntentParser implements IIntentParser {
  private readonly client: Anthropic;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly tokenRegistryService: ITokenRegistryService,
    private readonly chainId: number,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async parse(input: string, _userId: string): Promise<IntentPackage> {
    const tokens = await this.tokenRegistryService.listByChain(this.chainId);
    const tokenList = tokens
      .map((t) => `${t.symbol} (address: ${t.address}, decimals: ${t.decimals}, isNative: ${t.isNative})`)
      .join("\n");

    const systemPrompt = `You are an intent parser for an Avalanche DeFi trading agent.
Parse the user's message into a structured JSON IntentPackage. Output ONLY valid JSON, no prose.

Verified token list for chainId ${this.chainId}:
${tokenList}

Only use tokens from the verified list above. If the user references a token not in this list, set action to "unknown" and confidence to 0.

Output format:
{
  "action": "swap" | "stake" | "unstake" | "claim_rewards" | "transfer" | "unknown",
  "tokenIn": { "symbol": string, "address": string, "decimals": number, "amountHuman": string, "amountRaw": string } | undefined,
  "tokenOut": { "symbol": string, "address": string, "decimals": number } | undefined,
  "slippageBps": number | undefined,
  "recipient": string | undefined,
  "confidence": number (0-1),
  "rawInput": string
}

For amountRaw: multiply amountHuman by 10^decimals and express as integer string.
For AVAX: use address 0x0000000000000000000000000000000000000000.
Default slippageBps to 50 (0.5%) for swaps if not specified.`;

    const response = await this.client.messages.create({
      model: this.model,
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
      max_tokens: 1024,
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");
      const parsed = JSON.parse(jsonMatch[0]);
      const validated = IntentPackageSchema.parse({ ...parsed, rawInput: input });
      return validated as IntentPackage;
    } catch (err) {
      return {
        action: "unknown",
        confidence: 0,
        rawInput: input,
      };
    }
  }
}
