import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { AuthRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { ICapabilityDispatcher } from "../../../../use-cases/interface/input/capabilityDispatcher.interface";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("telegramHandler");
const MINI_APP_URL = process.env.MINI_APP_URL;

/**
 * Thin Telegram input adapter. Authentication gate + mini-app login prompt
 * live here; every user message or callback is forwarded to the
 * CapabilityDispatcher, which owns all business flow logic.
 */
export class TelegramAssistantHandler {
  private botRef: Bot | null = null;

  constructor(
    private readonly authUseCase: IAuthUseCase,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly capabilityDispatcher: ICapabilityDispatcher,
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
  ) {}

  register(bot: Bot): void {
    this.botRef = bot;

    bot.catch((err) => {
      log.error({ err: err.message, cause: err.error }, "bot error");
    });

    bot.command("start", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await this.sendWelcomeWithLoginButton(ctx.chat.id);
        return;
      }
      await ctx.reply("Onchain Agent online. Describe what you'd like to do on-chain.");
    });

    bot.callbackQuery("auth:login", async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        [
          "To authenticate:",
          "",
          "1. Open the *Aegis* mini app",
          "2. Sign in with Google",
          "3. Tap *Copy* next to your Agent Auth Token",
          "4. Send it here with: `/auth <token>`",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    });

    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data || data === "auth:login") return;
      await ctx.answerCallbackQuery();
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const session = await this.ensureAuthenticated(chatId);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      try {
        await this.capabilityDispatcher.handle({
          userId: session.userId,
          channelId: String(chatId),
          input: { kind: "callback", data },
        });
      } catch (err) {
        log.error({ err }, "callback dispatch error");
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });

    bot.command("logout", async (ctx) => {
      const chatId = ctx.chat.id;
      await this.telegramSessions.deleteByChatId(String(chatId));
      await ctx.reply("Logged out. Your session has been invalidated.");
      await this.sendWelcomeWithLoginButton(chatId);
    });

    // Superseded by POST /auth/privy, kept for older mini-app builds.
    bot.on("message:web_app_data", async (ctx) => {
      await this.handleWebAppData(ctx);
    });

    bot.on("message:text", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }

      await ctx.replyWithChatAction("typing");
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();
      const userId = session.userId;

      try {
        const result = await this.capabilityDispatcher.handle({
          userId,
          channelId: String(chatId),
          input: { kind: "text", text },
        });
        if (!result.handled) {
          await ctx.reply("I didn't understand that. Try a natural-language prompt.");
        }
      } catch (err) {
        log.error({ err }, "error handling message");
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  private async sendWelcomeWithLoginButton(chatId: number): Promise<void> {
    const now = newCurrentUTCEpoch();
    const request: AuthRequest = {
      requestId: newUuid(),
      requestType: "auth",
      telegramChatId: String(chatId),
      createdAt: now,
      expiresAt: now + 600,
    };
    if (!MINI_APP_URL) {
      await this.botRef!.api.sendMessage(chatId, "Welcome to Aegis.");
      return;
    }
    if (this.miniAppRequestCache) {
      await this.miniAppRequestCache.store(request);
    }
    const url = `${MINI_APP_URL}?requestId=${request.requestId}`;
    const reply_markup = new InlineKeyboard().webApp("Open Aegis", url);
    await this.botRef!.api.sendMessage(
      chatId,
      "Welcome to Aegis. Sign in to get started.",
      { reply_markup },
    );
  }

  private async handleWebAppData(ctx: {
    chat: { id: number };
    message: { web_app_data?: { data?: string } };
    reply: (text: string) => Promise<unknown>;
  }): Promise<void> {
    const raw = ctx.message.web_app_data?.data;
    if (!raw) return;
    let privyToken: string | undefined;
    try {
      privyToken = JSON.parse(raw)?.privyToken;
    } catch {
      await ctx.reply("Could not parse mini app data.");
      return;
    }
    if (!privyToken) {
      await ctx.reply("No token received from mini app.");
      return;
    }
    try {
      const { userId, expiresAtEpoch } = await this.authUseCase.loginWithPrivy({ privyToken });
      await this.telegramSessions.upsert({
        telegramChatId: String(ctx.chat.id),
        userId,
        expiresAtEpoch,
      });
      await ctx.reply("Authenticated with Google. You can now use the Onchain Agent.");
    } catch (err) {
      log.error({ err }, "web_app_data loginWithPrivy failed");
      await ctx.reply("Authentication failed. Please try again from the mini app.");
    }
  }

  private async ensureAuthenticated(chatId: number): Promise<{ userId: string } | null> {
    const session = await this.telegramSessions.findByChatId(String(chatId));
    if (!session) return null;
    if (session.expiresAtEpoch <= newCurrentUTCEpoch()) {
      await this.telegramSessions.deleteByChatId(String(chatId));
      return null;
    }
    return { userId: session.userId };
  }
}
