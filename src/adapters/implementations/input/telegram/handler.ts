import type { Bot } from "grammy";
import { v5 as uuidV5 } from "uuid";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { GoogleOAuthService } from "../../output/googleOAuth/googleOAuth.service";
import { PERSONALITIES } from "../../../../helpers/enums/personalities.enum";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

const TELEGRAM_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

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
}

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private setupSessions = new Map<number, SetupSession>();

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly fixedUserId?: string,
    private readonly botToken?: string,
  ) {}

  register(bot: Bot): void {
    bot.catch((err) => {
      console.error("Bot error:", err.message);
      if (err.error) console.error("Cause:", err.error);
    });

    bot.command("start", (ctx) =>
      ctx.reply("JARVIS online. Send me a message.\n\nRun /setup to personalize your experience."),
    );

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
      const messages = await this.assistantUseCase.getConversation({
        userId,
        conversationId,
      });
      const text = messages
        .slice(-10)
        .map((m) => `${m.role === "user" ? "You" : "JARVIS"}: ${m.content}`)
        .join("\n\n");
      return ctx.reply(text || "No messages yet.");
    });

    bot.command("setup", async (ctx) => {
      this.setupSessions.set(ctx.chat.id, {
        phase: { name: "traits", questionIndex: 0 },
        collectedTraits: [],
      });
      await this.safeSend(
        ctx,
        "Let's personalize JARVIS for you. Answer each question with *a* or *b*.\n\n" +
          TRAIT_QUESTIONS[0].text,
      );
    });

    bot.command("code", async (ctx) => {
      const code = ctx.match?.trim();
      if (!code) {
        return ctx.reply(
          "Usage: /code <authorization_code>\n\nCopy the `code` value from the redirect URL after authorizing Google.",
        );
      }
      const userId = this.resolveUserId(ctx.chat.id);
      try {
        await this.googleOAuthService.handleCallback(code, userId);
        await ctx.reply(
          "Google account connected. Calendar and Gmail are ready.",
        );
      } catch {
        await ctx.reply(
          "Authorization failed. The code may be expired — run /setup again to get a fresh link.",
        );
      }
    });

    bot.on("message:photo", async (ctx) => {
      if (this.setupSessions.has(ctx.chat.id)) return;

      const userId = this.resolveUserId(ctx.chat.id);
      const conversationId = this.conversations.get(ctx.chat.id);

      await ctx.replyWithChatAction("typing");

      try {
        const imageBase64Url = await this.downloadPhotoAsBase64(ctx);
        const caption = ctx.message.caption?.trim() || "[image]";

        const response = await this.assistantUseCase.chat({
          userId,
          conversationId,
          message: caption,
          imageBase64Url,
        });

        this.conversations.set(ctx.chat.id, response.conversationId);

        let reply = response.reply;
        if (response.toolsUsed.length > 0) {
          reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
        }

        await this.safeSend(ctx, reply);
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

  private async handleSetupReply(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const session = this.setupSessions.get(chatId)!;
    const text = (ctx.message as { text?: string }).text?.trim().toLowerCase();

    if (session.phase.name === "traits") {
      const { questionIndex } = session.phase;
      const question = TRAIT_QUESTIONS[questionIndex];

      if (text !== "a" && text !== "b") {
        await this.safeSend(ctx, "Please reply with *a* or *b*.\n\n" + question.text);
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
      if (isNaN(hour) || hour < 0 || hour > 23) {
        await ctx.reply(
          "Please enter a number between 0 and 23 (e.g. *7* for 7 AM, *22* for 10 PM).",
          { parse_mode: "Markdown" },
        );
        return;
      }

      const userId = this.resolveUserId(chatId);
      await this.userProfileRepo.upsert({
        userId,
        personalities: session.collectedTraits,
        wakeUpHour: hour,
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

  private async safeSend(ctx: Context, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text);
    }
  }

  private async downloadPhotoAsBase64(ctx: Context): Promise<string> {
    const photos = (ctx.message as { photo?: { file_id: string }[] }).photo!;
    const fileId = photos[photos.length - 1].file_id;

    const file = await ctx.api.getFile(fileId);
    const token = this.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:image/jpeg;base64,${base64}`;
  }

  private resolveUserId(chatId: number): string {
    return this.fixedUserId ?? uuidV5(String(chatId), TELEGRAM_NS);
  }
}
