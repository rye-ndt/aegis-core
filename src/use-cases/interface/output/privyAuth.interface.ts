export interface PrivyUserProfile {
  privyDid: string;
  email: string;
  googleEmail?: string;
  telegramUserId?: string;
  telegramUsername?: string;
  embeddedWalletAddress?: string;
  linkedExternalWallets: string[];  // 0x addresses of external wallets
  privyCreatedAt?: number;           // unix epoch, when the Privy user was created
}

// Keep old alias so nothing else breaks
export type PrivyVerifiedUser = Pick<PrivyUserProfile, 'privyDid' | 'email'>;

export interface IPrivyAuthService {
  verifyToken(accessToken: string): Promise<PrivyUserProfile>;
  verifyTokenLite(accessToken: string): Promise<{ privyDid: string }>;
  getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string>; // returns 0x address
}
