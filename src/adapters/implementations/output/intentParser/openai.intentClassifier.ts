import OpenAI from "openai";
import { openaiLimiter } from "../../../../helpers/concurrency/openaiLimiter";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { USER_INTENT_TYPE } from "../../../../helpers/enums/userIntentType.enum";
import type { IIntentClassifier } from "../../../../use-cases/interface/output/intentClassifier.interface";

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const ClassifySchema = z.object({
  intentType: z.nativeEnum(USER_INTENT_TYPE),
});

const SYSTEM_PROMPT = `You are a classifier for a DeFi agent. Given these user messages, classify what the user wants.
Return exactly one of: swap, send_token, contract_interaction, retrieve_balance, unknown.

- swap: user wants to exchange one token for another
- send_token: user wants to transfer/send tokens to an address
- contract_interaction: user wants to call a smart contract function (stake, claim rewards, etc.)
- retrieve_balance: user wants to check their balance, portfolio, or holdings
- unknown: the request does not match any on-chain action`;

export class OpenAIIntentClassifier implements IIntentClassifier {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async classify(messages: string[]): Promise<USER_INTENT_TYPE> {
    const userContent =
      messages.length === 1
        ? messages[0]!
        : messages.map((m, i) => `[Message ${i + 1}]: ${m}`).join("\n");

    const response = await openaiLimiter(() =>
      this.client.chat.completions.parse({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: zodResponseFormat(ClassifySchema, "classification"),
        max_tokens: 50,
      }),
    );

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) throw new Error("No parsed response from OpenAI intent classifier");

    console.log(`[OpenAIIntentClassifier] classified: ${parsed.intentType}`);
    return parsed.intentType;
  }
}
