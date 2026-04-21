import { Bot } from "grammy";
import type { TelegramAssistantHandler } from "./handler";

export class TelegramBot {
  constructor(private bot: Bot, handler: TelegramAssistantHandler) {
    handler.register(this.bot);
  }

  start(): void {
    this.bot.start();
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }
}
