export interface PrivyVerifiedUser {
  privyDid: string;
  email: string;
}

export interface IPrivyAuthService {
  verifyToken(accessToken: string): Promise<PrivyVerifiedUser>;
  getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string>; // returns 0x address
}
