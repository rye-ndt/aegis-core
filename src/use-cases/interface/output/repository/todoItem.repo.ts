export type TodoPriority = "low" | "medium" | "high" | "urgent";
export type TodoStatus = "open" | "done";

export interface TodoItem {
  id: string;
  userId: string;
  title: string;
  description?: string;
  deadlineEpoch: number;
  priority: TodoPriority;
  status: TodoStatus;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface ITodoItemDB {
  create(item: TodoItem): Promise<void>;
  findByUserId(userId: string, status?: TodoStatus): Promise<TodoItem[]>;
  markDone(id: string, updatedAtEpoch: number): Promise<void>;
}
