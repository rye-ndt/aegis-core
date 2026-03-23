import type { Bot } from "grammy";
import { v5 as uuidV5 } from "uuid";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { Context } from "grammy";

const TELEGRAM_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export class TelegramAssistantHandler {
  // In-memory conversation state per chat — same pattern as consoleCli.ts
  private conversations = new Map<number, string>();

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    /** If set, all chats share this userId (single-user personal bot mode) */
    private readonly fixedUserId?: string,
  ) {}

  register(bot: Bot): void {
    // Global error handler — prevents crashes on Telegram API or handler errors
    bot.catch((err) => {
      console.error("Bot error:", err.message);
    });

    bot.command("start", (ctx) => ctx.reply("JARVIS online. Send me a message."));

    bot.command("new", (ctx) => {
      this.conversations.delete(ctx.chat.id);
      return ctx.reply("Conversation reset. Starting fresh.");
    });

    bot.command("history", async (ctx) => {
      const conversationId = this.conversations.get(ctx.chat.id);
      if (!conversationId) {
        return ctx.reply("No active conversation yet. Send a message first.");
      }
      const userId = this.resolveUserId(ctx.chat.id);
      const messages = await this.assistantUseCase.getConversation({ userId, conversationId });
      const text = messages
        .slice(-10)
        .map((m) => `${m.role === "user" ? "You" : "JARVIS"}: ${m.content}`)
        .join("\n\n");
      return ctx.reply(text || "No messages yet.");
    });

    bot.on("message:text", async (ctx) => {
      const userId = this.resolveUserId(ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);

      await ctx.replyWithChatAction("typing");

      try {
        const response = await this.assistantUseCase.chat({
          userId,
          conversationId,
          message: ctx.message.text,
        });

        this.conversations.set(ctx.chat.id, response.conversationId);

        let reply = response.reply;
        if (response.toolsUsed.length > 0) {
          reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
        }

        await this.safeSend(ctx, reply);
      } catch (err) {
        console.error("Error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  /** Try Markdown first; fall back to plain text if Telegram rejects the formatting. */
  private async safeSend(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text);
    }
  }

  private resolveUserId(chatId: number): string {
    return this.fixedUserId ?? uuidV5(String(chatId), TELEGRAM_NS);
  }
}
