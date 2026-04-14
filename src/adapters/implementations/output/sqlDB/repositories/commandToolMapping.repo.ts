import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  ICommandToolMappingDB,
  ICommandToolMappingRecord,
} from "../../../../../use-cases/interface/output/repository/commandToolMapping.repo";
import { commandToolMappings } from "../schema";

export class DrizzleCommandToolMappingRepo implements ICommandToolMappingDB {
  constructor(private readonly db: NodePgDatabase) {}

  async upsert(record: ICommandToolMappingRecord): Promise<void> {
    await this.db
      .insert(commandToolMappings)
      .values({
        command:        record.command,
        toolId:         record.toolId,
        createdAtEpoch: record.createdAtEpoch,
        updatedAtEpoch: record.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: commandToolMappings.command,
        set: {
          toolId:         record.toolId,
          updatedAtEpoch: record.updatedAtEpoch,
        },
      });
  }

  async findByCommand(command: string): Promise<ICommandToolMappingRecord | undefined> {
    const rows = await this.db
      .select()
      .from(commandToolMappings)
      .where(eq(commandToolMappings.command, command))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      command:        row.command,
      toolId:         row.toolId,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }

  async listAll(): Promise<ICommandToolMappingRecord[]> {
    const rows = await this.db.select().from(commandToolMappings);
    return rows.map((row) => ({
      command:        row.command,
      toolId:         row.toolId,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    }));
  }

  async delete(command: string): Promise<void> {
    const result = await this.db
      .delete(commandToolMappings)
      .where(eq(commandToolMappings.command, command))
      .returning({ command: commandToolMappings.command });
    if (result.length === 0) {
      throw new Error(`MAPPING_NOT_FOUND: no mapping for command="${command}"`);
    }
  }
}
