export interface ITelegramSession {
  telegramChatId: string;
  userId: string;
  expiresAtEpoch: number;
  createdAtEpoch: number;
}

export interface TelegramSessionUpsert {
  telegramChatId: string;
  userId: string;
  expiresAtEpoch: number;
}

export interface ITelegramSessionDB {
  findByChatId(telegramChatId: string): Promise<ITelegramSession | null>;
  findByUserId(userId: string): Promise<ITelegramSession | null>;
  upsert(session: TelegramSessionUpsert): Promise<void>;
  deleteByChatId(telegramChatId: string): Promise<void>;
}
