import { eq } from "drizzle-orm";
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
        createdAtEpoch: now,
        updatedAtEpoch: now,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          displayName: profile.displayName ?? null,
          personalities: profile.personalities,
          wakeUpHour: profile.wakeUpHour,
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
    return {
      userId: rows[0].userId,
      displayName: rows[0].displayName,
      personalities: rows[0].personalities,
      wakeUpHour: rows[0].wakeUpHour,
      createdAtEpoch: rows[0].createdAtEpoch,
      updatedAtEpoch: rows[0].updatedAtEpoch,
    };
  }
}
