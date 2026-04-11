import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ISchemaCompiler, CompileResult } from "../../../../use-cases/interface/output/schemaCompiler.interface";
import type { ToolManifest } from "../../../../use-cases/interface/output/toolManifest.types";

const CompileSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  missingQuestion: z.string().nullable(),
  fromTokenSymbol: z.string().nullable(),
  toTokenSymbol: z.string().nullable(),
});

function buildSystemPrompt(
  manifest: ToolManifest,
  autoFilled: Record<string, unknown>,
  partialParams: Record<string, unknown>,
): string {
  return `You are a field extractor for a DeFi transaction agent.

Tool schema (inputSchema):
${JSON.stringify(manifest.inputSchema, null, 2)}

Auto-filled fields (do not ask user for these):
${JSON.stringify(autoFilled, null, 2)}

Previously extracted fields:
${JSON.stringify(partialParams, null, 2)}

Instructions:
- Scan the conversation and extract as many inputSchema fields as possible.
- Do NOT extract or ask for: tokenAddress, amountRaw (these are resolved later from token symbols).
- If the user mentions a token symbol (e.g. "USDC", "AVAX"), extract it as fromTokenSymbol or toTokenSymbol — NOT as tokenAddress.
- If any required field (from inputSchema.required) is still missing after extraction, set missingQuestion to a short, natural question to ask the user.
- If all required non-token fields are filled, set missingQuestion to null.
- Do not include auto-filled fields in params output.`;
}

export class OpenAISchemaCompiler implements ISchemaCompiler {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async compile(opts: {
    manifest: ToolManifest;
    messages: string[];
    autoFilled: Record<string, unknown>;
    partialParams: Record<string, unknown>;
  }): Promise<CompileResult> {
    const { manifest, messages, autoFilled, partialParams } = opts;

    const userContent =
      messages.length === 1
        ? messages[0]!
        : messages.map((m, i) => `[Message ${i + 1}]: ${m}`).join("\n");

    const systemPrompt = buildSystemPrompt(manifest, autoFilled, partialParams);

    const response = await this.client.chat.completions.parse({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: zodResponseFormat(CompileSchema, "compile_result"),
    });

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) throw new Error("No parsed response from OpenAI schema compiler");

    console.log(`[OpenAISchemaCompiler] params=${JSON.stringify(parsed.params)} missingQuestion=${parsed.missingQuestion} from=${parsed.fromTokenSymbol} to=${parsed.toTokenSymbol}`);

    const tokenSymbols: CompileResult["tokenSymbols"] = {};
    if (parsed.fromTokenSymbol) tokenSymbols.from = parsed.fromTokenSymbol;
    if (parsed.toTokenSymbol) tokenSymbols.to = parsed.toTokenSymbol;

    return {
      params: parsed.params,
      missingQuestion: parsed.missingQuestion,
      tokenSymbols,
    };
  }
}
