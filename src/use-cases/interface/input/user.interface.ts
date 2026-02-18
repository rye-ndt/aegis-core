import { USER_STATUSES } from "../../../helpers/enums/statuses.enum";

export interface IRegisterUser {
  fullName: string;
  userName: string;
  password: string;
  dob: number;
  email: string;
}

export interface ILoginUser {
  userName: string;
  password: string;
}

export interface IUser {
  id: string;
  fullName: string;
  userName: string;
  status: USER_STATUSES;
  bearerToken: string;
  refreshToken: string;
  lastEmailSentEpoch: number;
  registeredAtEpoch: number;
}

export interface IUserUseCase {
  register(data: IRegisterUser): Promise<IUser>;
  login(data: ILoginUser): Promise<IUser>;
  logout(accessToken: string): Promise<void>;
  refresh(refreshToken: string): Promise<IUser>;
  verifyEmail(bearerToken: string, code: string): Promise<IUser>;
}
