import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type { IEmailSender } from "../../../../use-cases/interface/output/emailSender.interface";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

const InputSchema = z.object({
  to: z.array(z.string()).describe("Recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text or HTML)"),
});

export class SendEmailTool implements ITool {
  constructor(private readonly emailSender: IEmailSender) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.SEND_EMAIL,
      description: "Send an email to one or more recipients.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { to, subject, body } = InputSchema.parse(input);
      await this.emailSender.send({ to, subject, html: body });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
}
