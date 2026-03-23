import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  GoogleOAuthToken,
  IGoogleOAuthTokenDB,
} from "../../../../../use-cases/interface/output/repository/googleOAuthToken.repo";
import { googleOAuthTokens } from "../schema";

export class DrizzleGoogleOAuthTokenRepo implements IGoogleOAuthTokenDB {
  constructor(private readonly db: NodePgDatabase) {}

  async findByUserId(userId: string): Promise<GoogleOAuthToken | null> {
    const rows = await this.db
      .select()
      .from(googleOAuthTokens)
      .where(eq(googleOAuthTokens.userId, userId))
      .limit(1);

    if (!rows[0]) return null;
    return this.toToken(rows[0]);
  }

  async upsert(token: GoogleOAuthToken): Promise<void> {
    await this.db
      .insert(googleOAuthTokens)
      .values({
        id: token.id,
        userId: token.userId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAtEpoch: token.expiresAtEpoch,
        scope: token.scope,
        updatedAtEpoch: token.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: googleOAuthTokens.userId,
        set: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAtEpoch: token.expiresAtEpoch,
          scope: token.scope,
          updatedAtEpoch: token.updatedAtEpoch,
        },
      });
  }

  private toToken(row: typeof googleOAuthTokens.$inferSelect): GoogleOAuthToken {
    return {
      id: row.id,
      userId: row.userId,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAtEpoch: row.expiresAtEpoch,
      scope: row.scope,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
