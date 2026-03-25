import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { GmailNotConnectedError } from "../../../../helpers/errors/gmailNotConnected.error";
import type { IGmailService } from "../../../../use-cases/interface/output/gmailService.interface";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

const InputSchema = z.object({
  query: z
    .string()
    .describe(
      'Gmail search query string (Gmail search syntax). Examples: "from:joan@example.com", ' +
        '"subject:interview", "from:joan subject:interview". Combine terms with spaces.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(10)
    .describe("Maximum number of emails to return. Hard-capped at 10."),
});

/** Returns true if the query string contains at least one email address. */
function containsEmailAddress(query: string): boolean {
  return /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(query);
}

export class GmailSearchEmailsTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly gmailService: IGmailService,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GMAIL_SEARCH_EMAILS,
      description:
        "Search the user's Gmail inbox using Gmail query syntax. " +
        "Returns up to 10 email summaries including sender, subject, snippet, threadId, and messageId. " +
        "Use this before drafting a reply to find the relevant email thread.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { query, maxResults } = InputSchema.parse(input);

      if (!containsEmailAddress(query)) {
        return {
          success: false,
          error:
            "Cannot search without an email address. " +
            "Ask the user: \"What is the sender's (or recipient's) email address?\" " +
            "Then retry with a query like \"from:<email> <topic keywords>\".",
        };
      }
      const emails = await this.gmailService.searchEmails(this.userId, {
        query,
        maxResults,
      });

      if (emails.length === 0) {
        return { success: true, data: "No emails found matching the query." };
      }

      const formatted = emails
        .map((e, i) =>
          [
            `${i + 1}. MessageID: ${e.messageId} | ThreadID: ${e.threadId}`,
            `   From: ${e.from}`,
            `   To: ${e.to.join(", ")}`,
            `   Subject: ${e.subject}`,
            `   Date: ${e.date}`,
            `   Snippet: ${e.snippet}`,
            `   Message-ID header: ${e.messageIdHeader}`,
          ].join("\n"),
        )
        .join("\n\n");

      return { success: true, data: formatted };
    } catch (err) {
      if (err instanceof GmailNotConnectedError) {
        return {
          success: false,
          error:
            "Gmail is not connected. Ask the user to visit /api/auth/google to authorize Gmail access.",
        };
      }
      throw err;
    }
  }
}
