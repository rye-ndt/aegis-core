import { eq } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { userPreferences } from "../schema";
import type { IUserPreference, IUserPreferencesDB } from "../../../../../use-cases/interface/output/repository/userPreference.repo";
import { newUuid } from "../../../../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";

export class DrizzleUserPreferencesRepo implements IUserPreferencesDB {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  async upsert(userId: string, patch: { aegisGuardEnabled: boolean }): Promise<void> {
    const defaultId = newUuid();
    const updatedEpoch = newCurrentUTCEpoch();
    
    await this.db
      .insert(userPreferences)
      .values({
        id: defaultId,
        userId,
        aegisGuardEnabled: patch.aegisGuardEnabled,
        updatedAtEpoch: updatedEpoch,
      })
      .onConflictDoUpdate({
        target: [userPreferences.userId],
        set: {
          aegisGuardEnabled: patch.aegisGuardEnabled,
          updatedAtEpoch: updatedEpoch,
        },
      });
  }

  async findByUserId(userId: string): Promise<IUserPreference | null> {
    const res = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    if (res.length === 0) return null;
    return res[0];
  }
}
