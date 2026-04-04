import { Bot } from "grammy";
import type { TelegramAssistantHandler } from "./handler";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

export class TelegramBot implements INotificationSender {
  private bot: Bot;

  constructor(token: string, handler: TelegramAssistantHandler) {
    this.bot = new Bot(token);
    handler.register(this.bot);
  }

  start(): void {
    this.bot.start();
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }

  async send(text: string, telegramChatId: string): Promise<void> {
    await this.bot.api.sendMessage(parseInt(telegramChatId, 10), text);
  }
}
