import { USER_STATUSES } from "../../../../helpers/enums/statuses.enum";
import { LOYALTY_STATUSES } from "../../../../helpers/enums/loyaltyStatuses.enum";

export interface UserInit {
  id: string;
  userName: string;
  hashedPassword?: string;
  email: string;
  privyDid?: string;
  status: USER_STATUSES;
  loyaltyStatus?: LOYALTY_STATUSES;
  telegramUsername?: string | null;
  telegramFirstName?: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserUpdate {
  id: string;
  userName: string;
  hashedPassword: string;
  email: string;
  status: USER_STATUSES;
  updatedAtEpoch: number;
}

export interface IUser extends UserInit {
  loyaltyStatus: LOYALTY_STATUSES;
}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  update(user: UserUpdate): Promise<void>;
  linkPrivyDid(userId: string, privyDid: string): Promise<void>;
  setTelegramProfile(
    userId: string,
    fields: { username?: string | null; firstName?: string | null },
  ): Promise<void>;
  findById(id: string): Promise<IUser | undefined>;
  findByEmail(email: string): Promise<IUser | null>;
  findByPrivyDid(privyDid: string): Promise<IUser | null>;
}
