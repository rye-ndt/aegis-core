import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { ITodoItemDB } from "../../../../use-cases/interface/output/repository/todoItem.repo";

const InputSchema = z.object({
  title: z.string().min(1).describe("Short description of the task"),
  description: z.string().optional().describe("Optional longer note about the task"),
  deadlineEpoch: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Deadline as a Unix timestamp in seconds (UTC). " +
        "Derive from the user's stated deadline. If not mentioned, omit this field.",
    ),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe(
      "Task urgency. Use 'urgent' only when explicitly stated. If not mentioned, omit this field.",
    ),
});

export class CreateTodoItemTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly todoItemRepo: ITodoItemDB,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CREATE_TODO_ITEM,
      description:
        "Save a task or to-do item the user needs to complete by a deadline. " +
        "Use this when the user mentions something they need to do later that is NOT a calendar event. " +
        "Requires a title, deadline, and priority. If either deadline or priority is missing, " +
        "this tool will tell you what to ask the user — then retry once you have both.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const parsed = InputSchema.parse(input);

    if (parsed.deadlineEpoch === undefined) {
      return {
        success: false,
        error:
          'Deadline is required. Ask the user: "By when do you need to complete this?" ' +
          "Convert their answer to a Unix timestamp in seconds, then retry with deadlineEpoch set.",
      };
    }

    if (parsed.priority === undefined) {
      return {
        success: false,
        error:
          'Priority is required. Ask the user: "How urgent is this — low, medium, high, or urgent?" ' +
          "Then retry with priority set.",
      };
    }

    const now = newCurrentUTCEpoch();
    const id = newUuid();

    await this.todoItemRepo.create({
      id,
      userId: this.userId,
      title: parsed.title,
      description: parsed.description,
      deadlineEpoch: parsed.deadlineEpoch,
      priority: parsed.priority,
      status: "open",
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    const deadlineStr = new Date(parsed.deadlineEpoch * 1000).toUTCString();
    return {
      success: true,
      data:
        `To-do saved: "${parsed.title}" | Priority: ${parsed.priority} | ` +
        `Deadline: ${deadlineStr} | ID: ${id}`,
    };
  }
}
