export interface PrivyVerifiedUser {
  privyDid: string;
  email: string;
}

export interface IPrivyAuthService {
  verifyToken(accessToken: string): Promise<PrivyVerifiedUser>;
}
