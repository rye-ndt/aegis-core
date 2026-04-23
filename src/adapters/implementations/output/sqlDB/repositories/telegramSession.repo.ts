import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import type {
  ITelegramSession,
  ITelegramSessionDB,
  TelegramSessionUpsert,
} from "../../../../../use-cases/interface/output/repository/telegramSession.repo";
import { telegramSessions } from "../schema";

export class DrizzleTelegramSessionRepo implements ITelegramSessionDB {
  constructor(private readonly db: NodePgDatabase) {}

  async findByChatId(telegramChatId: string): Promise<ITelegramSession | null> {
    const rows = await this.db
      .select()
      .from(telegramSessions)
      .where(eq(telegramSessions.telegramChatId, telegramChatId))
      .limit(1);
    if (!rows[0]) return null;
    return {
      telegramChatId: rows[0].telegramChatId,
      userId: rows[0].userId,
      expiresAtEpoch: rows[0].expiresAtEpoch,
      createdAtEpoch: rows[0].createdAtEpoch,
    };
  }

  async findByUserId(userId: string): Promise<ITelegramSession | null> {
    const rows = await this.db
      .select()
      .from(telegramSessions)
      .where(eq(telegramSessions.userId, userId))
      .limit(1);
    if (!rows[0]) return null;
    return {
      telegramChatId: rows[0].telegramChatId,
      userId: rows[0].userId,
      expiresAtEpoch: rows[0].expiresAtEpoch,
      createdAtEpoch: rows[0].createdAtEpoch,
    };
  }

  async upsert(session: TelegramSessionUpsert): Promise<void> {
    await this.db
      .insert(telegramSessions)
      .values({
        telegramChatId: session.telegramChatId,
        userId: session.userId,
        expiresAtEpoch: session.expiresAtEpoch,
        createdAtEpoch: newCurrentUTCEpoch(),
      })
      .onConflictDoUpdate({
        target: telegramSessions.telegramChatId,
        set: {
          userId: session.userId,
          expiresAtEpoch: session.expiresAtEpoch,
        },
      });
  }

  async deleteByChatId(telegramChatId: string): Promise<void> {
    await this.db
      .delete(telegramSessions)
      .where(eq(telegramSessions.telegramChatId, telegramChatId));
  }
}
