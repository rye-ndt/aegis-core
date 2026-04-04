import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { IAllowedTelegramIdDB } from "../../../../../use-cases/interface/output/repository/allowedTelegramId.repo";
import { allowedTelegramIds } from "../schema";

export class DrizzleAllowedTelegramIdRepo implements IAllowedTelegramIdDB {
  constructor(private readonly db: NodePgDatabase) {}

  async isAllowed(telegramChatId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(allowedTelegramIds)
      .where(eq(allowedTelegramIds.telegramChatId, telegramChatId))
      .limit(1);
    return rows.length > 0;
  }

  async add(telegramChatId: string, addedAtEpoch: number): Promise<void> {
    await this.db
      .insert(allowedTelegramIds)
      .values({ telegramChatId, addedAtEpoch })
      .onConflictDoNothing();
  }

  async remove(telegramChatId: string): Promise<void> {
    await this.db
      .delete(allowedTelegramIds)
      .where(eq(allowedTelegramIds.telegramChatId, telegramChatId));
  }

  async findAll(): Promise<string[]> {
    const rows = await this.db.select().from(allowedTelegramIds);
    return rows.map((r) => r.telegramChatId);
  }
}
