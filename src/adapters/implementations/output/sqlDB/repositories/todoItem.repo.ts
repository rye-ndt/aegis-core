import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  ITodoItemDB,
  TodoItem,
  TodoStatus,
} from "../../../../../use-cases/interface/output/repository/todoItem.repo";
import { todoItems } from "../schema";

export class DrizzleTodoItemRepo implements ITodoItemDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(item: TodoItem): Promise<void> {
    await this.db.insert(todoItems).values({
      id: item.id,
      userId: item.userId,
      title: item.title,
      description: item.description ?? null,
      deadlineEpoch: item.deadlineEpoch,
      priority: item.priority,
      status: item.status,
      createdAtEpoch: item.createdAtEpoch,
      updatedAtEpoch: item.updatedAtEpoch,
    });
  }

  async findByUserId(userId: string, status?: TodoStatus): Promise<TodoItem[]> {
    const conditions = status
      ? and(eq(todoItems.userId, userId), eq(todoItems.status, status))
      : eq(todoItems.userId, userId);

    const rows = await this.db.select().from(todoItems).where(conditions);
    return rows.map(this.toItem);
  }

  async markDone(id: string, updatedAtEpoch: number): Promise<void> {
    await this.db
      .update(todoItems)
      .set({ status: "done", updatedAtEpoch })
      .where(eq(todoItems.id, id));
  }

  private toItem(row: typeof todoItems.$inferSelect): TodoItem {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      description: row.description ?? undefined,
      deadlineEpoch: row.deadlineEpoch,
      priority: row.priority as TodoItem["priority"],
      status: row.status as TodoItem["status"],
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
