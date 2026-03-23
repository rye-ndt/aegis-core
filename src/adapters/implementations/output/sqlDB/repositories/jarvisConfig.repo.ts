import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IJarvisConfigDB,
  JarvisConfig,
} from "../../../../../use-cases/interface/output/repository/jarvisConfig.repo";
import { JARVIS_CONFIG_ROW_ID } from "../../../../../helpers/enums/jarvisConfig.enum";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";
import { jarvisConfig } from "../schema";

export class DrizzleJarvisConfigRepo implements IJarvisConfigDB {
  constructor(private readonly db: NodePgDatabase) {}

  async get(): Promise<JarvisConfig | null> {
    const rows = await this.db
      .select()
      .from(jarvisConfig)
      .where(eq(jarvisConfig.id, JARVIS_CONFIG_ROW_ID))
      .limit(1);

    if (!rows[0]) return null;
    return { systemPrompt: rows[0].systemPrompt };
  }

  async update(systemPrompt: string): Promise<void> {
    const now = newCurrentUTCEpoch();
    await this.db
      .insert(jarvisConfig)
      .values({
        id: JARVIS_CONFIG_ROW_ID,
        systemPrompt,
        updatedAtEpoch: now,
      })
      .onConflictDoUpdate({
        target: jarvisConfig.id,
        set: { systemPrompt, updatedAtEpoch: now },
      });
  }
}
