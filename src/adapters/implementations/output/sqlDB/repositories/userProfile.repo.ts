import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IUserProfile,
  IUserProfileDB,
  UserProfileInit,
  UserProfileUpdate,
} from "../../../../../use-cases/interface/output/repository/userProfile.repo";
import type { SESSION_KEY_STATUSES } from "../../../../../helpers/enums/sessionKeyStatus.enum";
import { userProfiles } from "../schema";

export class DrizzleUserProfileRepo implements IUserProfileDB {
  constructor(private readonly db: NodePgDatabase) {}

  async upsert(profile: UserProfileInit): Promise<void> {
    const eoaAddress = profile.eoaAddress ? profile.eoaAddress.toLowerCase() : null;
    await this.db
      .insert(userProfiles)
      .values({
        userId: profile.userId,
        telegramChatId: profile.telegramChatId ?? null,
        smartAccountAddress: profile.smartAccountAddress ?? null,
        eoaAddress,
        sessionKeyAddress: profile.sessionKeyAddress ?? null,
        sessionKeyScope: profile.sessionKeyScope ?? null,
        sessionKeyStatus: profile.sessionKeyStatus ?? null,
        sessionKeyExpiresAtEpoch: profile.sessionKeyExpiresAtEpoch ?? null,
        createdAtEpoch: profile.createdAtEpoch,
        updatedAtEpoch: profile.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          telegramChatId: profile.telegramChatId ?? null,
          smartAccountAddress: profile.smartAccountAddress ?? null,
          eoaAddress,
          sessionKeyAddress: profile.sessionKeyAddress ?? null,
          sessionKeyScope: profile.sessionKeyScope ?? null,
          sessionKeyStatus: profile.sessionKeyStatus ?? null,
          sessionKeyExpiresAtEpoch: profile.sessionKeyExpiresAtEpoch ?? null,
          updatedAtEpoch: profile.updatedAtEpoch,
        },
      });
  }

  async update(profile: UserProfileUpdate): Promise<void> {
    const eoaAddress = profile.eoaAddress ? profile.eoaAddress.toLowerCase() : null;
    await this.db
      .update(userProfiles)
      .set({
        telegramChatId: profile.telegramChatId ?? null,
        smartAccountAddress: profile.smartAccountAddress ?? null,
        eoaAddress,
        sessionKeyAddress: profile.sessionKeyAddress ?? null,
        sessionKeyScope: profile.sessionKeyScope ?? null,
        sessionKeyStatus: profile.sessionKeyStatus ?? null,
        sessionKeyExpiresAtEpoch: profile.sessionKeyExpiresAtEpoch ?? null,
        updatedAtEpoch: profile.updatedAtEpoch,
      })
      .where(eq(userProfiles.userId, profile.userId));
  }

  async setTelegramChatId(userId: string, telegramChatId: string, nowEpoch: number): Promise<void> {
    await this.db
      .insert(userProfiles)
      .values({
        userId,
        telegramChatId,
        createdAtEpoch: nowEpoch,
        updatedAtEpoch: nowEpoch,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          telegramChatId,
          updatedAtEpoch: nowEpoch,
        },
      });
  }

  async findByUserId(userId: string): Promise<IUserProfile | undefined> {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toIUserProfile(rows[0]);
  }

  async findByEoaAddress(eoa: string): Promise<IUserProfile | undefined> {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.eoaAddress, eoa.toLowerCase()))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toIUserProfile(rows[0]);
  }

  private toIUserProfile(row: typeof userProfiles.$inferSelect): IUserProfile {
    return {
      userId: row.userId,
      telegramChatId: row.telegramChatId,
      smartAccountAddress: row.smartAccountAddress,
      eoaAddress: row.eoaAddress,
      sessionKeyAddress: row.sessionKeyAddress,
      sessionKeyScope: row.sessionKeyScope,
      sessionKeyStatus: row.sessionKeyStatus as SESSION_KEY_STATUSES | null,
      sessionKeyExpiresAtEpoch: row.sessionKeyExpiresAtEpoch,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
