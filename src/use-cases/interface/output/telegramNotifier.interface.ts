export interface ITelegramNotifier {
  sendMessage(
    chatId: string,
    text: string,
    options?: { webAppButton?: { label: string; url: string } },
  ): Promise<void>;
}
