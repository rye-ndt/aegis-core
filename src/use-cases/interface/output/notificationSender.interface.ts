export interface INotificationSender {
  send(text: string): Promise<void>;
}

