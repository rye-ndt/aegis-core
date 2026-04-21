import { decryptValue } from "../../../../helpers/crypto/aes";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../use-cases/interface/output/tool.interface";
import type { IHttpQueryTool, IHttpQueryToolHeader } from "../../../../use-cases/interface/output/repository/httpQueryTool.repo";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ILLMOrchestrator } from "../../../../use-cases/interface/output/orchestrator.interface";
import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";

export class HttpQueryTool implements ITool {
  constructor(
    private readonly toolConfig: IHttpQueryTool,
    private readonly headers: IHttpQueryToolHeader[],
    private readonly userId: string,
    private readonly userProfileCache: IUserProfileCache | undefined,
    private readonly userProfileDB: IUserProfileDB,
    private readonly orchestrator: ILLMOrchestrator,
    private readonly encryptionKey?: string,
  ) {}

  definition(): IToolDefinition {
    const schema = JSON.parse(this.toolConfig.requestBodySchema) as Record<string, unknown>;
    return {
      name: this.toolConfig.name,
      description: this.toolConfig.description,
      inputSchema: schema,
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const [privyProfile, dbProfile] = await Promise.all([
        this.userProfileCache?.get(this.userId).catch(() => null) ?? Promise.resolve(null),
        this.userProfileDB.findByUserId(this.userId).catch(() => null),
      ]);

      const userContext: Record<string, unknown> = {
        walletAddress: dbProfile?.smartAccountAddress ?? dbProfile?.eoaAddress ?? null,
        email: privyProfile?.email ?? null,
        googleEmail: privyProfile?.googleEmail ?? null,
        telegramUserId: privyProfile?.telegramUserId ?? null,
        embeddedWalletAddress: privyProfile?.embeddedWalletAddress ?? null,
        linkedExternalWallets: privyProfile?.linkedExternalWallets ?? [],
      };

      const requestBodySchema = JSON.parse(this.toolConfig.requestBodySchema) as Record<string, unknown>;
      const marshalPrompt = [
        "You are a JSON request body builder. Given the JSON schema, provided tool parameters, and user context, produce a complete and valid JSON request body.",
        "Output ONLY the JSON object — no explanation, no markdown fences.",
        "",
        "JSON Schema:",
        JSON.stringify(requestBodySchema, null, 2),
        "",
        "Tool parameters (from user query):",
        JSON.stringify(input, null, 2),
        "",
        "User context (authoritative — prefer these values for user-specific fields):",
        JSON.stringify(userContext, null, 2),
      ].join("\n");

      const marshalResponse = await this.orchestrator.chat({
        systemPrompt: "You output only valid JSON objects.",
        conversationHistory: [{ role: MESSAGE_ROLE.USER, content: marshalPrompt }],
        availableTools: [],
      });

      let requestBody: unknown;
      try {
        requestBody = JSON.parse(marshalResponse.text ?? "{}");
      } catch {
        requestBody = {};
      }

      const resolvedHeaders: Record<string, string> = { "Content-Type": "application/json" };
      for (const h of this.headers) {
        const value =
          h.isEncrypted && this.encryptionKey
            ? decryptValue(h.headerValue, this.encryptionKey)
            : h.headerValue;
        resolvedHeaders[h.headerKey] = value;
      }

      const isGet = this.toolConfig.method === "GET";
      const bodyMap = requestBody as Record<string, unknown>;

      // Substitute {param} placeholders in the URL from the marshaled body, then remove consumed keys
      const remainingBody: Record<string, unknown> = { ...bodyMap };
      let url = this.toolConfig.endpoint.replace(/\{([^}]+)\}/g, (_, key: string) => {
        const val = remainingBody[key];
        if (val !== undefined && val !== null) {
          delete remainingBody[key];
          return encodeURIComponent(String(val));
        }
        return `{${key}}`;
      });

      let fetchBody: string | undefined;

      if (isGet) {
        const params = new URLSearchParams(
          Object.entries(remainingBody).map(([k, v]) => [k, String(v)]),
        );
        const qs = params.toString();
        url = qs ? `${url}?${qs}` : url;
      } else {
        fetchBody = JSON.stringify(remainingBody);
      }

      const httpResponse = await fetch(url, {
        method: this.toolConfig.method,
        headers: resolvedHeaders,
        ...(fetchBody !== undefined ? { body: fetchBody } : {}),
      });

      const rawText = await httpResponse.text();
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(rawText);
      } catch {
        rawJson = rawText;
      }

      if (!httpResponse.ok) {
        return {
          success: false,
          error: `HTTP ${httpResponse.status}: ${typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson)}`,
        };
      }

      const interpretPrompt = [
        "You are a data interpreter. The following is the JSON response from an external API.",
        "Summarize what the data means in clear, concise plain language suitable for a non-technical user.",
        "Output only the plain language summary — no code, no JSON, no markdown.",
        "",
        "Response:",
        typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson, null, 2),
      ].join("\n");

      const interpretResponse = await this.orchestrator.chat({
        systemPrompt: "You interpret API responses into plain language.",
        conversationHistory: [{ role: MESSAGE_ROLE.USER, content: interpretPrompt }],
        availableTools: [],
      });

      return { success: true, data: interpretResponse.text ?? JSON.stringify(rawJson) };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
