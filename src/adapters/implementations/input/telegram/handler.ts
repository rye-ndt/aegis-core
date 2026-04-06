import type { Bot, Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { PERSONALITIES } from "../../../../helpers/enums/personalities.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITextToSpeech } from "../../../../use-cases/interface/output/tts.interface";
import type { ITextGenerator } from "../../../../use-cases/interface/output/textGenerator.interface";
import type { GoogleOAuthService } from "../../output/googleOAuth/googleOAuth.service";

interface TraitQuestion {
  text: string;
  a: PERSONALITIES[];
  b: PERSONALITIES[];
}

const TRAIT_QUESTIONS: TraitQuestion[] = [
  {
    text: "1/6 — When I explain things, do you prefer:\n*(a)* Short & to the point\n*(b)* Detailed & comprehensive",
    a: [PERSONALITIES.MINIMALIST],
    b: [PERSONALITIES.THOROUGH],
  },
  {
    text: "2/6 — How should I talk to you?\n*(a)* Casual, like a friend\n*(b)* Professional & formal",
    a: [PERSONALITIES.CASUAL],
    b: [PERSONALITIES.FORMAL],
  },
  {
    text: "3/6 — Do you want humor in our conversations?\n*(a)* Yes, keep it fun\n*(b)* No, stay focused",
    a: [PERSONALITIES.HUMOROUS],
    b: [],
  },
  {
    text: "4/6 — When solving problems, you trust:\n*(a)* Logic & data\n*(b)* Gut feeling & instinct",
    a: [PERSONALITIES.ANALYTICAL, PERSONALITIES.LOGICAL],
    b: [PERSONALITIES.INTUITIVE],
  },
  {
    text: "5/6 — When giving feedback, should I be:\n*(a)* Blunt & direct\n*(b)* Thoughtful & gentle",
    a: [PERSONALITIES.DIRECT],
    b: [PERSONALITIES.EMPATHETIC, PERSONALITIES.SUPPORTIVE],
  },
  {
    text: "6/6 — My energy level should be:\n*(a)* High energy & enthusiastic\n*(b)* Calm & steady",
    a: [PERSONALITIES.ENTHUSIASTIC],
    b: [PERSONALITIES.CALM, PERSONALITIES.PATIENT],
  },
];

type SetupPhase =
  | { name: "traits"; questionIndex: number }
  | { name: "wakeup" }
  | { name: "done" };

interface SetupSession {
  phase: SetupPhase;
  collectedTraits: PERSONALITIES[];
  userId: string;
}

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private setupSessions = new Map<number, SetupSession>();
  private sessionCache = new Map<number, { userId: string; expiresAtEpoch: number }>();

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly tts: ITextToSpeech,
    private readonly textGenerator: ITextGenerator,
    private readonly authUseCase: IAuthUseCase,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly botToken?: string,
  ) {}

  private readonly RATING_KEYBOARD = (messageId: string) =>
    new InlineKeyboard()
      .text("⭐", `rate:${messageId}:1`)
      .text("⭐⭐", `rate:${messageId}:2`)
      .text("⭐⭐⭐", `rate:${messageId}:3`)
      .text("⭐⭐⭐⭐", `rate:${messageId}:4`)
      .text("⭐⭐⭐⭐⭐", `rate:${messageId}:5`);

  register(bot: Bot): void {
    bot.catch((err) => {
      console.error("Bot error:", err.message);
      if (err.error) console.error("Cause:", err.error);
    });

    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith("rate:")) return;

      const parts = data.split(":");
      const messageId = parts[1];
      const rating = parseInt(parts[2], 10);

      if (!messageId || isNaN(rating) || rating < 1 || rating > 5) return;

      try {
        await this.assistantUseCase.submitRating(messageId, rating);
        await ctx.answerCallbackQuery({ text: "Thank you — your gracious feedback has been noted." });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
      } catch {
        await ctx.answerCallbackQuery({ text: "We were unable to record your response. Please try again." });
      }
    });

    bot.command("start", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("JARVIS online.\n\nAuthenticate first: call POST /auth/login to get a token, then send /auth <token> here.");
        return;
      }
      await ctx.reply("JARVIS online. Send me a message.\n\nRun /setup to personalize your experience.");
    });

    bot.command("auth", async (ctx) => {
      const token = ctx.match?.trim();
      if (!token) {
        await ctx.reply("Usage: /auth <your_token>\n\nGet a token via POST /auth/login.");
        return;
      }
      try {
        const { userId, expiresAtEpoch } = await this.authUseCase.validateToken(token);
        await this.telegramSessions.upsert({
          telegramChatId: String(ctx.chat.id),
          userId,
          expiresAtEpoch,
        });
        this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
        await ctx.reply("Authenticated. You can now use JARVIS.");
      } catch {
        await ctx.reply("Invalid or expired token. Get a fresh token via POST /auth/login.");
      }
    });

    bot.command("logout", async (ctx) => {
      const chatId = ctx.chat.id;
      await this.telegramSessions.deleteByChatId(String(chatId));
      this.sessionCache.delete(chatId);
      this.conversations.delete(chatId);
      await ctx.reply("Logged out. Your session has been invalidated.");
    });

    bot.command("new", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      this.conversations.delete(ctx.chat.id);
      await ctx.reply("Conversation reset. Starting fresh.");
    });

    bot.command("history", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      const conversationId = this.conversations.get(ctx.chat.id);
      if (!conversationId) {
        return ctx.reply("No active conversation yet. Send a message first.");
      }
      const messages = await this.assistantUseCase.getConversation({
        userId: session.userId,
        conversationId,
      });
      const text = messages
        .slice(-10)
        .map((m) => `${m.role === "user" ? "You" : "JARVIS"}: ${m.content}`)
        .join("\n\n");
      return ctx.reply(text || "No messages yet.");
    });

    bot.command("setup", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      this.setupSessions.set(ctx.chat.id, {
        phase: { name: "traits", questionIndex: 0 },
        collectedTraits: [],
        userId: session.userId,
      });
      await this.safeSend(
        ctx,
        "Let's personalize JARVIS for you. Answer each question with *a* or *b*.\n\n" +
          TRAIT_QUESTIONS[0].text,
      );
    });

    bot.command("code", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      const code = ctx.match?.trim();
      if (!code) {
        return ctx.reply(
          "Usage: /code <authorization_code>\n\nCopy the `code` value from the redirect URL after authorizing Google.",
        );
      }
      try {
        await this.googleOAuthService.handleCallback(code, session.userId);
        await ctx.reply("Google account connected. Calendar and Gmail are ready.");
      } catch {
        await ctx.reply(
          "Authorization failed. The code may be expired — use /setup to get a fresh link.",
        );
      }
    });

    bot.command("speech", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      const message = ctx.match?.trim();
      if (!message) {
        return ctx.reply("Usage: /speech <your message>");
      }
      await this.ensureUserProfile(session.userId, ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);
      await ctx.replyWithChatAction("record_voice");
      try {
        const response = await this.assistantUseCase.chat({
          userId: session.userId,
          conversationId,
          message,
        });
        this.conversations.set(ctx.chat.id, response.conversationId);
        try {
          const { audioBuffer } = await this.tts.synthesize({ text: response.reply });
          await ctx.replyWithVoice(new InputFile(audioBuffer, "reply.ogg"));
          if (response.toolsUsed.length > 0) {
            await ctx.reply(`[tools: ${response.toolsUsed.join(", ")}]`);
            await this.sendRatingPrompt(ctx, response.messageId, response.toolsUsed);
          }
        } catch (ttsErr) {
          console.error("TTS synthesis failed:", ttsErr);
          let reply = response.reply;
          if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
          await this.safeSend(ctx, `${reply}\n\n_(voice unavailable)_`);
          if (response.toolsUsed.length > 0) await this.sendRatingPrompt(ctx, response.messageId, response.toolsUsed);
        }
      } catch (err) {
        console.error("Error handling /speech:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });

    bot.on("message:voice", async (ctx) => {
      if (this.setupSessions.has(ctx.chat.id)) return;
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      await this.ensureUserProfile(session.userId, ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);
      await ctx.replyWithChatAction("record_voice");
      try {
        const audioBuffer = await this.downloadVoiceAsBuffer(ctx);
        const response = await this.assistantUseCase.voiceChat({
          userId: session.userId,
          conversationId,
          audioBuffer,
          mimeType: "audio/ogg",
        });
        this.conversations.set(ctx.chat.id, response.conversationId);
        try {
          const { audioBuffer: replyAudio } = await this.tts.synthesize({ text: response.reply });
          await ctx.replyWithVoice(new InputFile(replyAudio, "reply.ogg"));
          if (response.toolsUsed.length > 0) {
            await ctx.reply(`[tools: ${response.toolsUsed.join(", ")}]`);
            await this.sendRatingPrompt(ctx, response.messageId, response.toolsUsed);
          }
        } catch (ttsErr) {
          console.error("TTS failed for voice reply:", ttsErr);
          let reply = response.reply;
          if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
          await this.safeSend(ctx, `${reply}\n\n_(voice reply unavailable)_`);
          if (response.toolsUsed.length > 0) await this.sendRatingPrompt(ctx, response.messageId, response.toolsUsed);
        }
      } catch (err) {
        console.error("Error handling voice message:", err);
        await ctx.reply("Sorry, I couldn't process that voice message. Please try again.");
      }
    });

    bot.on("message:photo", async (ctx) => {
      if (this.setupSessions.has(ctx.chat.id)) return;
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      await this.ensureUserProfile(session.userId, ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);
      await ctx.replyWithChatAction("typing");
      try {
        const imageBase64Url = await this.downloadPhotoAsBase64(ctx);
        const caption = ctx.message.caption?.trim() || "[image]";
        const response = await this.assistantUseCase.chat({
          userId: session.userId,
          conversationId,
          message: caption,
          imageBase64Url,
        });
        this.conversations.set(ctx.chat.id, response.conversationId);
        let reply = response.reply;
        if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
        await this.safeSend(ctx, reply);
        if (response.toolsUsed.length > 0) await this.sendRatingPrompt(ctx, response.messageId, response.toolsUsed);
      } catch (err) {
        console.error("Error handling photo:", err);
        await ctx.reply("Sorry, I couldn't process that image. Please try again.");
      }
    });

    bot.on("message:text", async (ctx) => {
      if (this.setupSessions.has(ctx.chat.id)) {
        await this.handleSetupReply(ctx);
        return;
      }
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      await this.ensureUserProfile(session.userId, ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);
      await ctx.replyWithChatAction("typing");
      try {
        const response = await this.assistantUseCase.chat({
          userId: session.userId,
          conversationId,
          message: ctx.message.text,
        });
        this.conversations.set(ctx.chat.id, response.conversationId);
        let reply = response.reply;
        if (response.toolsUsed.length > 0) reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
        await this.safeSend(ctx, reply);
        if (response.toolsUsed.length > 0) await this.sendRatingPrompt(ctx, response.messageId, response.toolsUsed);
      } catch (err) {
        console.error("Error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  private async ensureAuthenticated(chatId: number): Promise<{ userId: string } | null> {
    const now = newCurrentUTCEpoch();
    const cached = this.sessionCache.get(chatId);
    if (cached) {
      if (cached.expiresAtEpoch > now) return { userId: cached.userId };
      this.sessionCache.delete(chatId);
      await this.telegramSessions.deleteByChatId(String(chatId));
      return null;
    }
    const session = await this.telegramSessions.findByChatId(String(chatId));
    if (!session) return null;
    if (session.expiresAtEpoch <= now) {
      await this.telegramSessions.deleteByChatId(String(chatId));
      return null;
    }
    this.sessionCache.set(chatId, { userId: session.userId, expiresAtEpoch: session.expiresAtEpoch });
    return { userId: session.userId };
  }

  private async handleSetupReply(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = this.setupSessions.get(chatId);
    if (!session) return;
    const text = (ctx.message as { text?: string }).text?.trim().toLowerCase();

    if (session.phase.name === "traits") {
      const { questionIndex } = session.phase;
      const question = TRAIT_QUESTIONS[questionIndex];

      if (text !== "a" && text !== "b") {
        await this.safeSend(
          ctx,
          `Please reply with *a* or *b*.\n\n${question.text}`,
        );
        return;
      }

      const chosen = text === "a" ? question.a : question.b;
      session.collectedTraits.push(...chosen);

      const nextIndex = questionIndex + 1;
      if (nextIndex < TRAIT_QUESTIONS.length) {
        session.phase = { name: "traits", questionIndex: nextIndex };
        await this.safeSend(ctx, TRAIT_QUESTIONS[nextIndex].text);
      } else {
        session.phase = { name: "wakeup" };
        await ctx.reply(
          "Almost done!\n\nWhat time do you usually wake up? Reply with just the hour in 24h format (0–23, e.g. *7* for 7 AM).",
          { parse_mode: "Markdown" },
        );
      }
      return;
    }

    if (session.phase.name === "wakeup") {
      const hour = parseInt(text ?? "", 10);
      if (Number.isNaN(hour) || hour < 0 || hour > 23) {
        await ctx.reply(
          "Please enter a number between 0 and 23 (e.g. *7* for 7 AM, *22* for 10 PM).",
          { parse_mode: "Markdown" },
        );
        return;
      }

      const userId = session.userId;
      await this.userProfileRepo.upsert({
        userId,
        personalities: session.collectedTraits,
        wakeUpHour: hour,
        telegramChatId: String(chatId),
      });

      session.phase = { name: "done" };
      this.setupSessions.delete(chatId);

      const authUrl = this.googleOAuthService.generateAuthUrl(userId);
      await ctx.reply(
        "Profile saved! JARVIS is now tuned to you.\n\nTap the button below to connect Google Calendar and Gmail.\n\nIf the redirect page doesn't load, copy the `code` from the URL and send `/code <value>` here.",
        {
          reply_markup: new InlineKeyboard().url("Connect Google", authUrl),
        },
      );
      return;
    }
  }

  private async sendRatingPrompt(ctx: Context, messageId: string, toolsUsed: string[]): Promise<void> {
    try {
      const toolContext = toolsUsed.length > 0 ? `Tools used: ${toolsUsed.join(", ")}.` : "";
      const prompt = await this.textGenerator.generate(
        `You are the voice of a five-star luxury concierge AI assistant. Your task is to ask the user for feedback on the service just rendered — but do so with elegance, warmth, and restraint, as a world-class concierge would. Never mention numbers, stars, or a rating scale in your message. The rating buttons will appear below your message automatically. Write a single sentence or two at most. Vary your phrasing each time — never repeat the same form. Do not start with "I".`,
        `The assistant just completed the following for the user. ${toolContext} Compose your feedback invitation now.`,
      );
      await ctx.reply(prompt.trim(), { reply_markup: this.RATING_KEYBOARD(messageId) });
    } catch {
      // non-critical — swallow silently
    }
  }

  private async safeSend(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text);
    }
  }

  private async downloadVoiceAsBuffer(ctx: Context): Promise<Buffer> {
    const voice = (ctx.message as { voice?: { file_id: string } }).voice;
    if (!voice) throw new Error("Voice message missing voice field");
    const file = await ctx.api.getFile(voice.file_id);
    const token = this.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    return Buffer.from(await response.arrayBuffer());
  }

  private async downloadPhotoAsBase64(ctx: Context): Promise<string> {
    const photos = (ctx.message as { photo?: { file_id: string }[] }).photo;
    if (!photos) throw new Error("Photo message missing photo field");
    const fileId = photos[photos.length - 1].file_id;

    const file = await ctx.api.getFile(fileId);
    const token = this.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return `data:image/jpeg;base64,${base64}`;
  }

  private async ensureUserProfile(userId: string, chatId: number): Promise<void> {
    const existing = await this.userProfileRepo.findByUserId(userId);
    if (!existing) {
      await this.userProfileRepo.upsert({
        userId,
        personalities: [],
        wakeUpHour: null,
        telegramChatId: String(chatId),
      });
    } else if (!existing.telegramChatId) {
      await this.userProfileRepo.upsert({
        userId,
        personalities: existing.personalities,
        wakeUpHour: existing.wakeUpHour,
        telegramChatId: String(chatId),
      });
    }
  }
}
