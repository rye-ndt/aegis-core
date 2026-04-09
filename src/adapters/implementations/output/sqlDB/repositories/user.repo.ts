import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type {
  IUser,
  IUserDB,
  UserInit,
  UserUpdate,
} from "../../../../../use-cases/interface/output/repository/user.repo";
import { USER_STATUSES } from "../../../../../helpers/enums/statuses.enum";
import { users } from "../schema";

export class DrizzleUserRepo implements IUserDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(user: UserInit): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      userName: user.userName,
      hashedPassword: user.hashedPassword,
      email: user.email,
      status: user.status,
      createdAtEpoch: user.createdAtEpoch,
      updatedAtEpoch: user.updatedAtEpoch,
    });
  }

  async update(user: UserUpdate): Promise<void> {
    await this.db
      .update(users)
      .set({
        userName: user.userName,
        hashedPassword: user.hashedPassword,
        email: user.email,
        status: user.status,
        updatedAtEpoch: user.updatedAtEpoch,
      })
      .where(eq(users.id, user.id));
  }

  async findById(id: string): Promise<IUser | undefined> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toIUser(rows[0]);
  }

  async findByEmail(email: string): Promise<IUser | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!rows[0]) return null;
    return this.toIUser(rows[0]);
  }

  private toIUser(row: typeof users.$inferSelect): IUser {
    return {
      id: row.id,
      userName: row.userName,
      hashedPassword: row.hashedPassword,
      email: row.email,
      status: row.status as USER_STATUSES,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
