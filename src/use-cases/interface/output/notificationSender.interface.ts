export interface INotificationSender {
  send(text: string, telegramChatId: string): Promise<void>;
}

