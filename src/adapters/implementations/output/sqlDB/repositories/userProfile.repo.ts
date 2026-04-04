import { asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IUserProfile,
  IUserProfileDB,
  UserProfileUpsert,
} from "../../../../../use-cases/interface/output/repository/userProfile.repo";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import { userProfiles } from "../schema";

export class DrizzleUserProfileRepo implements IUserProfileDB {
  constructor(private readonly db: NodePgDatabase) {}

  async upsert(profile: UserProfileUpsert): Promise<void> {
    const now = newCurrentUTCEpoch();
    await this.db
      .insert(userProfiles)
      .values({
        userId: profile.userId,
        displayName: profile.displayName ?? null,
        personalities: profile.personalities,
        wakeUpHour: profile.wakeUpHour,
        telegramChatId: profile.telegramChatId ?? null,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          displayName: profile.displayName ?? null,
          personalities: profile.personalities,
          wakeUpHour: profile.wakeUpHour,
          telegramChatId: profile.telegramChatId ?? null,
          updatedAtEpoch: now,
        },
      });
  }

  async findByUserId(userId: string): Promise<IUserProfile | null> {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    if (!rows[0]) return null;
    return this.toProfile(rows[0]);
  }

  async findByTelegramChatId(chatId: string): Promise<IUserProfile | null> {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.telegramChatId, chatId))
      .limit(1);

    if (!rows[0]) return null;
    return this.toProfile(rows[0]);
  }

  async findAll(): Promise<IUserProfile[]> {
    const rows = await this.db.select().from(userProfiles);
    return rows.map(this.toProfile);
  }

  async findFirst(): Promise<IUserProfile | null> {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .orderBy(asc(userProfiles.createdAtEpoch))
      .limit(1);

    if (!rows[0]) return null;
    return this.toProfile(rows[0]);
  }

  private toProfile(row: typeof userProfiles.$inferSelect): IUserProfile {
    return {
      userId: row.userId,
      displayName: row.displayName,
      personalities: row.personalities,
      wakeUpHour: row.wakeUpHour,
      telegramChatId: row.telegramChatId,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
