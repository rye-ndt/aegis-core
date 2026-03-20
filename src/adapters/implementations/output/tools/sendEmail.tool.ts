import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type { IEmailSender } from "../../../../use-cases/interface/output/emailSender.interface";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

export class SendEmailTool implements ITool {
  constructor(private readonly emailSender: IEmailSender) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.SEND_EMAIL,
      description: "Send an email to one or more recipients.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "array",
            items: { type: "string" },
            description: "Recipient email addresses",
          },
          subject: { type: "string", description: "Email subject" },
          body: {
            type: "string",
            description: "Email body (plain text or HTML)",
          },
        },
        required: ["to", "subject", "body"],
      },
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      await this.emailSender.send({
        to: input.to as string[],
        subject: input.subject as string,
        html: input.body as string,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
}
