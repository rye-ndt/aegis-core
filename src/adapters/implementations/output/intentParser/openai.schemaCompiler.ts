import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ISchemaCompiler, CompileResult } from "../../../../use-cases/interface/output/schemaCompiler.interface";
import type { ToolManifest } from "../../../../use-cases/interface/output/toolManifest.types";
import { extractAddressFields } from "../../../../helpers/schema/addressFields";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";

const CompileSchema = z.object({
  paramsJson:           z.string(),
  missingQuestion:      z.string().nullable(),
  fromTokenSymbol:      z.string().nullable(),
  toTokenSymbol:        z.string().nullable(),
  telegramHandle:       z.string().nullable(),
  /**
   * JSON-encoded Partial<Record<string, string>> present only for dual-schema tools.
   * Keys are RESOLVER_FIELD enum values; values are the raw human-provided strings.
   * null when the tool does not define requiredFields.
   */
  resolverFieldsJson:   z.string().nullable(),
});

function stripAddressFields(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const addressFields = extractAddressFields(inputSchema);
  if (addressFields.length === 0) return inputSchema;

  const properties = { ...(inputSchema.properties as Record<string, unknown>) };
  for (const field of addressFields) delete properties[field];

  const required = (inputSchema.required as string[] | undefined)
    ?.filter((f) => !addressFields.includes(f));

  return { ...inputSchema, properties, required };
}

function buildSystemPrompt(
  manifest: ToolManifest,
  autoFilled: Record<string, unknown>,
  partialParams: Record<string, unknown>,
): string {
  const rawSchema = manifest.inputSchema as Record<string, unknown>;
  const addressFields = extractAddressFields(rawSchema);
  const visibleSchema = stripAddressFields(rawSchema);

  console.log(`[OpenAISchemaCompiler] addressFields=${JSON.stringify(addressFields)} visibleSchema=${JSON.stringify(visibleSchema)}`);

  const hasDualSchema =
    manifest.requiredFields &&
    typeof manifest.requiredFields === "object" &&
    Object.keys(manifest.requiredFields).length > 0;

  const resolverFieldsInstruction = hasDualSchema
    ? `

This tool uses the dual-schema extraction model.
You MUST populate resolverFieldsJson — do NOT set it to null.
Extract values for these resolver fields from the conversation:
${JSON.stringify(manifest.requiredFields, null, 2)}

Emit them as a JSON-encoded string in resolverFieldsJson.
Keys must exactly match the requiredFields property names
(e.g. "fromTokenSymbol", "toTokenSymbol", "readableAmount", "userHandle").
Only include keys where the user has explicitly provided a value.
If the user provided some but not all values, still emit the ones you found.
Only use null for resolverFieldsJson if the user provided absolutely no resolver field values.`
    : `
- Set resolverFieldsJson to null (this tool does not use the dual-schema model).`;

  return `You are a field extractor for a DeFi transaction agent.

Tool schema (inputSchema):
${JSON.stringify(visibleSchema, null, 2)}

Auto-filled fields (do not ask user for these):
${JSON.stringify(autoFilled, null, 2)}

Previously extracted fields:
${JSON.stringify(partialParams, null, 2)}

Instructions:
- Scan the conversation and extract as many inputSchema fields as possible.
- If the user mentions a token symbol (e.g. "USDC", "${CHAIN_CONFIG.nativeSymbol}", "MOON"), extract it as fromTokenSymbol or toTokenSymbol.
- If any required field (from inputSchema.required) is still missing, set missingQuestion to a short, natural question to ask the user.
- If all required fields are filled, set missingQuestion to null.
- Do not include auto-filled fields in params output.
- If the user mentions a Telegram handle as the recipient (a word starting with @ followed by alphanumerics/underscores/hyphens, referring to a *person*, not a protocol, token name, or brand), extract it into telegramHandle without the @ prefix (e.g. "rye-ndt"). Only set this when the intent is to send tokens TO that specific person. If no person handle is mentioned, set telegramHandle to null.
- Output extracted params as a JSON-encoded string in the paramsJson field (e.g. "{\"amount\":\"5\"}"). Use "{}" if no params were extracted.${resolverFieldsInstruction}`;
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

    const params = JSON.parse(parsed.paramsJson) as Record<string, unknown>;

    console.log(
      `[OpenAISchemaCompiler] params=${JSON.stringify(params)} missingQuestion=${parsed.missingQuestion} from=${parsed.fromTokenSymbol} to=${parsed.toTokenSymbol} resolverFieldsJson=${parsed.resolverFieldsJson}`,
    );

    const tokenSymbols: CompileResult["tokenSymbols"] = {};
    if (parsed.fromTokenSymbol) tokenSymbols.from = parsed.fromTokenSymbol;
    if (parsed.toTokenSymbol) tokenSymbols.to = parsed.toTokenSymbol;

    let resolverFields: Partial<Record<string, string>> | undefined;
    if (parsed.resolverFieldsJson) {
      try {
        resolverFields = JSON.parse(parsed.resolverFieldsJson) as Partial<
          Record<string, string>
        >;
      } catch {
        // Malformed JSON from LLM — fall through to undefined (legacy path continues)
        console.warn(
          "[OpenAISchemaCompiler] could not parse resolverFieldsJson, ignoring",
        );
      }
    }

    return {
      params,
      missingQuestion: parsed.missingQuestion,
      tokenSymbols,
      telegramHandle: parsed.telegramHandle ?? undefined,
      resolverFields,
    };
  }

  async generateQuestion(opts: {
    manifest: ToolManifest;
    missingFields: string[];
  }): Promise<string> {
    const properties = (opts.manifest.inputSchema as Record<string, unknown>).properties as
      Record<string, { description?: string }> | undefined ?? {};

    const fieldDescriptions = opts.missingFields
      .map((f) => properties[f]?.description ? `${f} (${properties[f].description})` : f)
      .join(", ");

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `You are a DeFi assistant. Ask the user to provide the following missing transaction fields in a short, friendly, natural sentence: ${fieldDescriptions}`,
        },
      ],
    });

    return (
      response.choices[0]?.message.content ??
      `Could you provide the following: ${opts.missingFields.join(", ")}?`
    );
  }
}
