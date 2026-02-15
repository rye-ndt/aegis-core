import {
  PERSONALITIES,
  PRIMARY_CATEGORY,
} from "../../../../helpers/enums/categories.enum";
import { USER_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface UserInit {
  id: string;
  fullName: string;
  userName: string;
  hashedPassword: string;
  createdAtEpoch: number;
}

export interface IUser extends UserInit {
  status: USER_STATUSES;
  personalities: PERSONALITIES[];
  preferredCategories: PRIMARY_CATEGORY[];
  secondaryPersonalities: string[];
}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  findById(id: string): Promise<IUser>;
}
