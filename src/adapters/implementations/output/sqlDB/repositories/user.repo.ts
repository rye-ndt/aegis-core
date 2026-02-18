import { eq, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type {
  ILoginUser,
  IUser as UseCaseUser,
} from "../../../../../use-cases/interface/input/user.interface";
import type {
  IUser,
  IUserDB,
  UserInit,
  UserUpdate,
} from "../../../../../use-cases/interface/output/repository/user.repo";
import { users } from "../schema";

export class DrizzleUserRepo implements IUserDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(user: UserInit): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      fullName: user.fullName,
      userName: user.userName,
      hashedPassword: user.hashedPassword,
      email: user.email,
      dob: user.dob,
      role: user.role,
      status: user.status,
      personalities: [],
      preferredCategories: [],
      secondaryPersonalities: [],
      createdAtEpoch: user.createdAtEpoch,
      updatedAtEpoch: user.updatedAtEpoch,
    });
  }

  async update(user: UserUpdate): Promise<void> {
    await this.db
      .update(users)
      .set({
        fullName: user.fullName,
        userName: user.userName,
        hashedPassword: user.hashedPassword,
        email: user.email,
        dob: user.dob,
        role: user.role,
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

    return rows[0];
  }

  async findByUsernameOrEmail(
    username: string,
    email: string,
  ): Promise<IUser | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(or(eq(users.userName, username), eq(users.email, email)))
      .limit(1);

    return rows[0] ?? null;
  }

  async login(_data: ILoginUser): Promise<UseCaseUser> {
    throw new Error("DrizzleUserRepo.login is not implemented.");
  }

  async logout(_accessToken: string): Promise<void> {
    throw new Error("DrizzleUserRepo.logout is not implemented.");
  }

  async refresh(_refreshToken: string): Promise<UseCaseUser> {
    throw new Error("DrizzleUserRepo.refresh is not implemented.");
  }
}

