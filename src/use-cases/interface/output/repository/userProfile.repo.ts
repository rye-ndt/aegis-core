export interface IUserProfile {
  userId: string;
  displayName: string | null;
  personalities: string[];
  wakeUpHour: number | null;
  telegramChatId: string | null;
  smartAccountAddress: string | null;
  eoaAddress: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserProfileUpsert {
  userId: string;
  displayName?: string;
  personalities: string[];
  wakeUpHour: number | null;
  telegramChatId?: string;
}

export interface IUserProfileDB {
  upsert(profile: UserProfileUpsert): Promise<void>;
  findByUserId(userId: string): Promise<IUserProfile | null>;
  findByTelegramChatId(chatId: string): Promise<IUserProfile | null>;
  findAll(): Promise<IUserProfile[]>;
  findFirst(): Promise<IUserProfile | null>;
  updateSmartAccount(userId: string, smartAccountAddress: string, eoaAddress: string): Promise<void>;
}
