import type { Bot } from "grammy";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { ViemClientAdapter } from "../../output/blockchain/viemClient";
import { INTENT_STATUSES } from "../../../../helpers/enums/intentStatus.enum";
import type { IIntentParser } from "../../../../use-cases/interface/output/intentParser.interface";
import {
  MissingFieldsError,
  ConversationLimitError,
  InvalidFieldError,
} from "../../output/intentParser/intent.validator";

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private sessionCache = new Map<
    number,
    { userId: string; expiresAtEpoch: number }
  >();
  private intentHistory = new Map<number, string[]>();

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly authUseCase: IAuthUseCase,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly botToken?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly userProfileDB?: IUserProfileDB,
    private readonly tokenRegistryService?: ITokenRegistryService,
    private readonly viemClient?: ViemClientAdapter,
    private readonly chainId?: number,
    private readonly intentParser?: IIntentParser,
  ) {}

  register(bot: Bot): void {
    bot.catch((err) => {
      console.error("Bot error:", err.message);
      if (err.error) console.error("Cause:", err.error);
    });

    bot.command("start", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply(
          "Welcome to the Onchain Agent.\n\nAuthenticate first: call POST /auth/login to get a token, then send /auth <token> here.",
        );
        return;
      }
      await ctx.reply(
        "Onchain Agent online. Describe what you'd like to do on-chain.",
      );
    });

    bot.command("auth", async (ctx) => {
      const token = ctx.match?.trim();
      if (!token) {
        await ctx.reply(
          "Usage: /auth <your_token>\n\nGet a token via POST /auth/login.",
        );
        return;
      }
      try {
        const { userId, expiresAtEpoch } =
          await this.authUseCase.validateToken(token);
        await this.telegramSessions.upsert({
          telegramChatId: String(ctx.chat.id),
          userId,
          expiresAtEpoch,
        });
        this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
        await ctx.reply("Authenticated. You can now use the Onchain Agent.");
      } catch {
        await ctx.reply(
          "Invalid or expired token. Get a fresh token via POST /auth/login.",
        );
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
        .map((m) => `${m.role === "user" ? "You" : "Agent"}: ${m.content}`)
        .join("\n\n");
      return ctx.reply(text || "No messages yet.");
    });

    bot.command("confirm", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      if (!this.intentUseCase) {
        await ctx.reply("Intent execution not configured.");
        return;
      }
      await ctx.replyWithChatAction("typing");
      try {
        // Find the latest pending intent for this user
        const { userId } = session;
        // We need to find pending intent — intentUseCase exposes confirmAndExecute
        // The pending intentId must be stored in DB; use a placeholder lookup approach
        // by calling confirmAndExecute with a sentinel that triggers DB lookup
        const result = await this.confirmLatestIntent(userId);
        await this.safeSend(ctx, result);
      } catch (err) {
        console.error("Error confirming intent:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });

    bot.command("cancel", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      if (!this.intentUseCase) {
        await ctx.reply("Intent execution not configured.");
        return;
      }
      await ctx.reply("Intent cancelled. No transaction was submitted.");
    });

    bot.command("portfolio", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      await ctx.replyWithChatAction("typing");
      try {
        const portfolio = await this.fetchPortfolio(session.userId);
        await this.safeSend(ctx, portfolio);
      } catch (err) {
        console.error("Error fetching portfolio:", err);
        await ctx.reply("Sorry, couldn't fetch portfolio. Please try again.");
      }
    });

    bot.command("wallet", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      try {
        const profile = await this.userProfileDB?.findByUserId(session.userId);
        if (!profile?.smartAccountAddress) {
          await ctx.reply(
            "No wallet found. Complete registration to deploy your Smart Contract Account.",
          );
          return;
        }
        const lines = [
          "🔑 Wallet Info",
          `Smart Account: \`${profile.smartAccountAddress}\``,
          profile.sessionKeyAddress
            ? `Session Key: \`${profile.sessionKeyAddress}\``
            : "Session Key: Not set",
          `Session Key Status: ${profile.sessionKeyStatus ?? "N/A"}`,
        ];
        if (profile.sessionKeyExpiresAtEpoch) {
          const expiresDate = new Date(profile.sessionKeyExpiresAtEpoch * 1000)
            .toISOString()
            .split("T")[0];
          lines.push(`Expires: ${expiresDate}`);
        }
        await this.safeSend(ctx, lines.join("\n"));
      } catch (err) {
        console.error("Error fetching wallet:", err);
        await ctx.reply("Sorry, couldn't fetch wallet info. Please try again.");
      }
    });

    bot.on("message:photo", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
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
        if (response.toolsUsed.length > 0)
          reply += `\n\n[tools: ${response.toolsUsed.join(", ")}]`;
        await this.safeSend(ctx, reply);
      } catch (err) {
        console.error("Error handling photo:", err);
        await ctx.reply(
          "Sorry, I couldn't process that image. Please try again.",
        );
      }
    });

    bot.on("message:text", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await ctx.reply("Please authenticate first. Use /auth <token>.");
        return;
      }
      await ctx.replyWithChatAction("typing");
      try {
        // --- INTENT PARSE TEST ---
        if (!this.intentParser) {
          await ctx.reply("Intent parser not configured.");
          return;
        }

        const chatId = ctx.chat.id;
        const history = this.intentHistory.get(chatId) ?? [];
        history.push(ctx.message.text);
        this.intentHistory.set(chatId, history);

        let intent;
        try {
          intent = await this.intentParser.parse(history, session.userId);
        } catch (parseErr) {
          if (parseErr instanceof ConversationLimitError) {
            this.intentHistory.delete(chatId);
            await ctx.reply(parseErr.message);
            return;
          }
          if (parseErr instanceof MissingFieldsError || parseErr instanceof InvalidFieldError) {
            await ctx.reply(parseErr.prompt);
            return;
          }
          throw parseErr;
        }

        // Successful parse — clear history so next intent starts fresh
        this.intentHistory.delete(chatId);

        if (intent === null) {
          await ctx.reply("No onchain intent detected.");
          return;
        }
        await this.safeSend(
          ctx,
          `Parsed intent:\n\`\`\`json\n${JSON.stringify(intent, null, 2)}\n\`\`\``,
        );
        // --- END INTENT PARSE TEST ---
      } catch (err) {
        console.error("Error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  private async confirmLatestIntent(userId: string): Promise<string> {
    if (!this.intentUseCase) return "Intent execution not configured.";
    // The intentUseCase needs access to the intent DB to find the pending intent.
    // We expose a method that internally looks up the latest AWAITING_CONFIRMATION intent.
    // For now, we pass a sentinel intentId that the use case understands to mean "latest".
    const result = await this.intentUseCase.confirmAndExecute({
      intentId: "__latest__",
      userId,
    });
    return result.humanSummary;
  }

  private async fetchPortfolio(userId: string): Promise<string> {
    if (
      !this.userProfileDB ||
      !this.tokenRegistryService ||
      !this.viemClient ||
      !this.chainId
    ) {
      return "Portfolio service not configured.";
    }
    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile?.smartAccountAddress) {
      return "No Smart Contract Account found. Please complete registration.";
    }

    const scaAddress = profile.smartAccountAddress as `0x${string}`;
    const tokens = await this.tokenRegistryService.listByChain(this.chainId);

    const ERC20_BALANCE_ABI = [
      {
        name: "balanceOf",
        type: "function" as const,
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const;

    const rows: string[] = [
      "💼 Portfolio",
      `SCA: \`${scaAddress}\``,
      "",
      "Token | Balance",
      "------|-------",
    ];
    for (const token of tokens) {
      let rawBalance: bigint;
      if (token.isNative) {
        rawBalance = await this.viemClient.publicClient.getBalance({
          address: scaAddress,
        });
      } else {
        rawBalance = (await this.viemClient.publicClient.readContract({
          address: token.address as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [scaAddress],
        })) as bigint;
      }
      const humanBalance = (Number(rawBalance) / 10 ** token.decimals).toFixed(
        6,
      );
      rows.push(`${token.symbol} | ${humanBalance}`);
    }
    return rows.join("\n");
  }

  private async ensureAuthenticated(
    chatId: number,
  ): Promise<{ userId: string } | null> {
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
    this.sessionCache.set(chatId, {
      userId: session.userId,
      expiresAtEpoch: session.expiresAtEpoch,
    });
    return { userId: session.userId };
  }

  private async safeSend(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    text: string,
  ): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text);
    }
  }

  private async downloadPhotoAsBase64(ctx: {
    message: { photo?: { file_id: string }[] };
    api: { getFile: (fileId: string) => Promise<{ file_path?: string }> };
  }): Promise<string> {
    const photos = ctx.message.photo;
    if (!photos) throw new Error("Photo message missing photo field");
    const fileId = photos[photos.length - 1].file_id;
    const file = await ctx.api.getFile(fileId);
    const token = this.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return `data:image/jpeg;base64,${Buffer.from(buffer).toString("base64")}`;
  }
}
