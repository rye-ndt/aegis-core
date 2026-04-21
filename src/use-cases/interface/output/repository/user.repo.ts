import { USER_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface UserInit {
  id: string;
  userName: string;
  hashedPassword?: string;
  email: string;
  privyDid?: string;
  status: USER_STATUSES;
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

export interface IUser extends UserInit {}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  update(user: UserUpdate): Promise<void>;
  linkPrivyDid(userId: string, privyDid: string): Promise<void>;
  findById(id: string): Promise<IUser | undefined>;
  findByEmail(email: string): Promise<IUser | null>;
  findByPrivyDid(privyDid: string): Promise<IUser | null>;
}
