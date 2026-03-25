import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type {
  ITodoItemDB,
  TodoItem,
  TodoPriority,
  TodoStatus,
} from "../../../../use-cases/interface/output/repository/todoItem.repo";

const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const InputSchema = z.object({
  status: z
    .enum(["open", "done", "all"])
    .default("open")
    .describe("Filter by status. Default is 'open'."),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe("Optional priority filter. Omit to return all priorities."),
});

export class RetrieveTodoItemsTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly todoItemRepo: ITodoItemDB,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.RETRIEVE_TODO_ITEMS,
      description:
        "Retrieve the user's to-do list. Returns tasks sorted by urgency then deadline. " +
        "Call this when the user asks what they need to do, lists their tasks, or checks pending items.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { status, priority } = InputSchema.parse(input);

    const statusFilter: TodoStatus | undefined =
      status === "all" ? undefined : status;

    let items = await this.todoItemRepo.findByUserId(this.userId, statusFilter);

    if (priority) {
      items = items.filter((i) => i.priority === priority);
    }

    if (items.length === 0) {
      return { success: true, data: "No to-do items found." };
    }

    items.sort((a: TodoItem, b: TodoItem) => {
      const weightDiff =
        PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      return weightDiff !== 0 ? weightDiff : a.deadlineEpoch - b.deadlineEpoch;
    });

    const formatted = items
      .map((item: TodoItem, i: number) => {
        const deadline = new Date(item.deadlineEpoch * 1000).toUTCString();
        const tag = item.priority.toUpperCase().padEnd(6);
        const desc = item.description ? ` — ${item.description}` : "";
        return `${i + 1}. [${tag}] ${item.title}${desc} | due ${deadline} | status: ${item.status}`;
      })
      .join("\n");

    return { success: true, data: formatted };
  }
}
