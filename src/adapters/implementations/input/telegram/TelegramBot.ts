import { Bot } from "grammy";
import type { TelegramAssistantHandler } from "./assistantHandler.telegram";

export class TelegramBot {
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
}
