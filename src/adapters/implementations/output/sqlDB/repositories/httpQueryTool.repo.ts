import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { httpQueryTools, httpQueryToolHeaders } from "../schema";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import type {
  IHttpQueryToolDB,
  IHttpQueryTool,
  IHttpQueryToolHeader,
  ICreateHttpQueryTool,
  ICreateHttpQueryToolHeader,
} from "../../../../../use-cases/interface/output/repository/httpQueryTool.repo";

export class DrizzleHttpQueryToolRepo implements IHttpQueryToolDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(tool: ICreateHttpQueryTool): Promise<void> {
    await this.db.insert(httpQueryTools).values(tool);
  }

  async createHeaders(headers: ICreateHttpQueryToolHeader[]): Promise<void> {
    if (headers.length === 0) return;
    await this.db.insert(httpQueryToolHeaders).values(headers);
  }

  async findActiveByUser(userId: string): Promise<IHttpQueryTool[]> {
    const rows = await this.db
      .select()
      .from(httpQueryTools)
      .where(and(eq(httpQueryTools.userId, userId), eq(httpQueryTools.isActive, true)));
    return rows as IHttpQueryTool[];
  }

  async findById(id: string): Promise<IHttpQueryTool | null> {
    const rows = await this.db
      .select()
      .from(httpQueryTools)
      .where(eq(httpQueryTools.id, id))
      .limit(1);
    return (rows[0] as IHttpQueryTool) ?? null;
  }

  async getHeaders(toolId: string): Promise<IHttpQueryToolHeader[]> {
    return this.db
      .select()
      .from(httpQueryToolHeaders)
      .where(eq(httpQueryToolHeaders.toolId, toolId));
  }

  async deactivate(id: string, _userId: string): Promise<void> {
    await this.db
      .update(httpQueryTools)
      .set({ isActive: false, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(httpQueryTools.id, id));
  }
}
