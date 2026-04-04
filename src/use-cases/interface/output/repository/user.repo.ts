import { PERSONALITIES } from "../../../../helpers/enums/personalities.enum";
import { USER_STATUSES } from "../../../../helpers/enums/statuses.enum";

export interface UserInit {
  id: string;
  userName: string;
  hashedPassword: string;
  email: string;
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

export interface IUser extends UserInit {
  personalities: PERSONALITIES[];
  secondaryPersonalities: string[];
}

export interface IUserDB {
  create(user: UserInit): Promise<void>;
  update(user: UserUpdate): Promise<void>;
  findById(id: string): Promise<IUser | undefined>;
  findByEmail(email: string): Promise<IUser | null>;
}
