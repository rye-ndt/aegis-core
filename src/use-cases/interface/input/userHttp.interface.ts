import { USER_STATUSES } from "../../../helpers/enums/statuses.enum";
import { USER_ROLES } from "../../../helpers/enums/userRole.enum";

export interface IRegisterUserRequest {
  fullName: string;
  userName: string;
  password: string;
  dob: number;
  email: string;
}

export interface ILoginUserRequest {
  userName: string;
  password: string;
}

export interface IVerifyEmailRequest {
  code: string;
}

export interface IUserResponse {
  id: string;
  fullName: string;
  userName: string;
  status: USER_STATUSES;
  role: USER_ROLES;
  bearerToken: string;
  refreshToken: string;
  lastEmailSentEpoch: number;
  registeredAtEpoch: number;
}

