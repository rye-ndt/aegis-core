export interface IAllowedTelegramIdDB {
  isAllowed(telegramChatId: string): Promise<boolean>;
  add(telegramChatId: string, addedAtEpoch: number): Promise<void>;
  remove(telegramChatId: string): Promise<void>;
  findAll(): Promise<string[]>;
}
