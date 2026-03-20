import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

// TODO: implement persistent reminders (cron-based, push notification, or email)
export class ReminderTool implements ITool {
  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.REMINDER_SET,
      description: "Set a reminder for a specific time.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "What to remind the user about",
          },
          remindAtEpoch: {
            type: "number",
            description:
              "Unix timestamp (seconds) when to fire the reminder",
          },
        },
        required: ["message", "remindAtEpoch"],
      },
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    throw new Error("ReminderTool.execute() not yet implemented");
  }
}
