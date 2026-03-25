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
  to: z
    .array(z.string().email())
    .min(1)
    .describe("Recipient email address(es)."),
  subject: z
    .string()
    .describe(
      'Email subject line. For replies, prefix with "Re: " and keep the original subject.',
    ),
  body: z
    .string()
    .describe(
      "Full email body. Plain text. Write a complete, professional email.",
    ),
  threadId: z
    .string()
    .optional()
    .describe(
      "Gmail thread ID from the search results. Include this to attach the draft to an existing thread.",
    ),
  replyToMessageId: z
    .string()
    .optional()
    .describe(
      "The messageId (NOT the Message-ID header) of the email being replied to. " +
        "Used to set In-Reply-To threading headers.",
    ),
  replyToMessageIdHeader: z
    .string()
    .optional()
    .describe(
      "The Message-ID header value (the angle-bracket string like <abc@mail.gmail.com>) " +
        "of the email being replied to. Placed in the RFC 2822 In-Reply-To and References headers.",
    ),
});

export class GmailCreateDraftTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly gmailService: IGmailService,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.GMAIL_CREATE_DRAFT,
      description:
        "Create a Gmail draft on behalf of the user. " +
        "The draft is saved to Gmail Drafts and NOT sent automatically. " +
        "Use threadId and replyToMessageIdHeader from gmail_search_emails results when replying. " +
        "After calling this tool, tell the user to check their Gmail Drafts folder.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const parsed = InputSchema.parse(input);
      const { draftId } = await this.gmailService.createDraft(
        this.userId,
        parsed,
      );
      return {
        success: true,
        data: `Draft created successfully. Draft ID: ${draftId}. The draft is in Gmail Drafts — it has NOT been sent.`,
      };
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
