import {
  PERSONALITIES,
  PRIMARY_CATEGORY,
} from "../../../../helpers/enums/categories.enum";
import { USER_STATUSES } from "../../../../helpers/enums/statuses.enum";
import type {
  ILoginUser,
  IUser as UseCaseUser,
} from "../../input/user.interface";

export interface UserInit {
  id: string;
  fullName: string;
  userName: string;
  hashedPassword: string;
  email: string;
  dob: number;
  status: USER_STATUSES;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserUpdate {
  id: string;
  fullName: string;
  userName: string;
  hashedPassword: string;
  email: string;
  dob: number;
  status: USER_STATUSES;
  updatedAtEpoch: number;
}

export interface IUser extends UserInit {
  personalities: PERSONALITIES[];
  preferredCategories: PRIMARY_CATEGORY[];
  secondaryPersonalities: string[];
}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  update(user: UserUpdate): Promise<void>;
  findById(id: string): Promise<IUser | undefined>;
  findByUsernameOrEmail(username: string, email: string): Promise<IUser | null>;
  login(data: ILoginUser): Promise<UseCaseUser>;
  logout(accessToken: string): Promise<void>;
  refresh(refreshToken: string): Promise<UseCaseUser>;
}
