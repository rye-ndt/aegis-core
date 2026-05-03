import type { SESSION_KEY_STATUSES } from "../../../../helpers/enums/sessionKeyStatus.enum";

export interface IUserProfile {
  userId: string;
  telegramChatId?: string | null;
  smartAccountAddress?: string | null;
  eoaAddress?: string | null;
  sessionKeyAddress?: string | null;
  sessionKeyScope?: string | null;
  sessionKeyStatus?: SESSION_KEY_STATUSES | null;
  sessionKeyExpiresAtEpoch?: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserProfileInit {
  userId: string;
  telegramChatId?: string | null;
  smartAccountAddress?: string | null;
  eoaAddress?: string | null;
  sessionKeyAddress?: string | null;
  sessionKeyScope?: string | null;
  sessionKeyStatus?: SESSION_KEY_STATUSES | null;
  sessionKeyExpiresAtEpoch?: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserProfileUpdate {
  userId: string;
  telegramChatId?: string | null;
  smartAccountAddress?: string | null;
  eoaAddress?: string | null;
  sessionKeyAddress?: string | null;
  sessionKeyScope?: string | null;
  sessionKeyStatus?: SESSION_KEY_STATUSES | null;
  sessionKeyExpiresAtEpoch?: number | null;
  updatedAtEpoch: number;
}

export interface IUserProfileDB {
  upsert(profile: UserProfileInit): Promise<void>;
  update(profile: UserProfileUpdate): Promise<void>;
  findByUserId(userId: string): Promise<IUserProfile | undefined>;
  /**
   * Lookup by Privy embedded EOA. Used by recipient resolution to fetch the
   * canonical smart-account address for an already-onboarded user. EOA is
   * canonicalized to lowercase before comparison.
   */
  findByEoaAddress(eoa: string): Promise<IUserProfile | undefined>;
  /**
   * Partial-update path: writes the telegram chat id without touching any
   * other column. Inserts a stub profile when one doesn't exist yet so login
   * from the Telegram bot is never lost even if the smart-account hasn't been
   * provisioned. See yieldOptimizerUseCase.scanIdleForUser for the read side.
   */
  setTelegramChatId(userId: string, telegramChatId: string, nowEpoch: number): Promise<void>;
}
