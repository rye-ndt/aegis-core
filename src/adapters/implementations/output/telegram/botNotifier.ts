import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { ITelegramNotifier } from "../../../../use-cases/interface/output/telegramNotifier.interface";

export class BotTelegramNotifier implements ITelegramNotifier {
  constructor(private readonly bot: Bot) {}

  async sendMessage(
    chatId: string,
    text: string,
    options?: { webAppButton?: { label: string; url: string } },
  ): Promise<void> {
    const replyMarkup = options?.webAppButton
      ? new InlineKeyboard().webApp(options.webAppButton.label, options.webAppButton.url)
      : undefined;
    await this.bot.api.sendMessage(Number(chatId), text, {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}
