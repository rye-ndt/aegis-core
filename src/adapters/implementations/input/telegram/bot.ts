import { Bot } from "grammy";
import type { TelegramAssistantHandler } from "./handler";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

export class TelegramBot implements INotificationSender {
  private bot: Bot;

  constructor(
    token: string,
    handler: TelegramAssistantHandler,
    private readonly notificationChatId?: number,
  ) {
    this.bot = new Bot(token);
    handler.register(this.bot);
    if (!notificationChatId) {
      console.warn(
        "TELEGRAM_CHAT_ID not configured — proactive reminders disabled.",
      );
    }
  }

  start(): void {
    this.bot.start();
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }

  async send(text: string): Promise<void> {
    if (!this.notificationChatId) return;
    await this.bot.api.sendMessage(this.notificationChatId, text);
  }
}
