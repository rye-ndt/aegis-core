import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { toRaw } from "../../../../helpers/bigint";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import {
  type ITokenRecord,
  type ToolManifest,
} from "../../../../use-cases/interface/input/intent.interface";
import { USER_INTENT_TYPE } from "../../../../helpers/enums/userIntentType.enum";

type OrchestratorStage = "compile" | "token_disambig";

interface DisambiguationPending {
  resolvedFrom: ITokenRecord | null;
  resolvedTo: ITokenRecord | null;
  awaitingSlot: "from" | "to";
  fromCandidates: ITokenRecord[];
  toCandidates: ITokenRecord[];
}

interface OrchestratorSession {
  stage: OrchestratorStage;
  conversationId: string;
  messages: string[];
  manifest: ToolManifest;
  partialParams: Record<string, unknown>;
  tokenSymbols: { from?: string; to?: string };
  disambiguation?: DisambiguationPending;
}

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private sessionCache = new Map<
    number,
    { userId: string; expiresAtEpoch: number }
  >();
  private orchestratorSessions = new Map<number, OrchestratorSession>();

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly authUseCase: IAuthUseCase,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly botToken?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly portfolioUseCase?: IPortfolioUseCase,
    private readonly chainId: number = parseInt(
      process.env.CHAIN_ID ?? "43113",
      10,
    ),
  ) {}

  register(bot: Bot): void {
    bot.catch((err) => {
      console.error("Bot error:", err.message);
      if (err.error) console.error("Cause:", err.error);
    });

    bot.command("start", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        const keyboard = new InlineKeyboard().text(
          "Sign in with Google",
          "auth:login",
        );
        await ctx.reply(
          "Welcome to the Onchain Agent.\n\nSign in with Google via the Aegis mini app to get started.",
          { reply_markup: keyboard },
        );
        return;
      }
      await ctx.reply(
        "Onchain Agent online. Describe what you'd like to do on-chain.",
      );
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

    bot.command("auth", async (ctx) => {
      const privyToken = ctx.match?.trim();
      if (!privyToken) {
        await ctx.reply(
          "Usage: /auth <privy_token>\n\nGet your token from the Aegis mini app after signing in with Google.",
        );
        return;
      }
      try {
        const { userId, expiresAtEpoch } =
          await this.authUseCase.loginWithPrivy({ privyToken });
        await this.telegramSessions.upsert({
          telegramChatId: String(ctx.chat.id),
          userId,
          expiresAtEpoch,
        });
        this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
        await ctx.reply(
          "Authenticated with Google via Privy. You can now use the Onchain Agent.",
        );
      } catch {
        await ctx.reply(
          "Invalid or expired token. Open the Aegis mini app and copy a fresh token.",
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
        const result = await this.confirmLatestIntent(session.userId);
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
      this.orchestratorSessions.delete(ctx.chat.id);
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
        const info = await this.portfolioUseCase?.getWalletInfo(session.userId);
        if (!info?.smartAccountAddress) {
          await ctx.reply(
            "No wallet found. Complete registration to deploy your Smart Contract Account.",
          );
          return;
        }
        const lines = [
          "🔑 Wallet Info",
          `Smart Account: \`${info.smartAccountAddress}\``,
          info.sessionKeyAddress
            ? `Session Key: \`${info.sessionKeyAddress}\``
            : "Session Key: Not set",
          `Session Key Status: ${info.sessionKeyStatus ?? "N/A"}`,
        ];
        if (info.sessionKeyExpiresAtEpoch) {
          const expiresDate = new Date(info.sessionKeyExpiresAtEpoch * 1000)
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

    bot.on("message:web_app_data", async (ctx) => {
      const raw = ctx.message.web_app_data?.data;
      if (!raw) return;
      let privyToken: string | undefined;
      try {
        const parsed = JSON.parse(raw);
        privyToken = parsed?.privyToken;
      } catch {
        await ctx.reply("Could not parse mini app data.");
        return;
      }
      if (!privyToken) {
        await ctx.reply("No token received from mini app.");
        return;
      }
      try {
        const { userId, expiresAtEpoch } =
          await this.authUseCase.loginWithPrivy({ privyToken });
        await this.telegramSessions.upsert({
          telegramChatId: String(ctx.chat.id),
          userId,
          expiresAtEpoch,
        });
        this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
        await ctx.reply(
          "Authenticated with Google. You can now use the Onchain Agent.",
        );
      } catch {
        await ctx.reply(
          "Authentication failed. Please try again from the mini app.",
        );
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

      if (!this.intentUseCase) {
        await ctx.reply("Intent service not configured.");
        return;
      }

      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();
      const userId = session.userId;

      console.log(
        `[Handler] message chatId=${chatId} userId=${userId} text="${text}"`,
      );

      try {
        const existing = this.orchestratorSessions.get(chatId);

        // Route token_disambig replies
        if (existing?.stage === "token_disambig") {
          console.log(
            `[Handler] token_disambig active, routing to handleDisambiguationReply`,
          );
          await this.handleDisambiguationReply(
            ctx,
            chatId,
            text,
            userId,
            existing,
          );
          return;
        }

        // First message of this intent — classify + select tool
        if (!existing) {
          console.log(`[Handler] no session, classifying intent...`);
          const intentType = await this.intentUseCase.classifyIntent([text]);
          console.log(`[Handler] intentType=${intentType}`);

          if (
            intentType === USER_INTENT_TYPE.RETRIEVE_BALANCE ||
            intentType === USER_INTENT_TYPE.UNKNOWN
          ) {
            await this.handleFallbackChat(ctx, chatId, text, userId);
            return;
          }

          const toolResult = await this.intentUseCase.selectTool(intentType, [
            text,
          ]);
          if (!toolResult) {
            console.log(`[Handler] no tool found, falling back to chat`);
            await this.handleFallbackChat(ctx, chatId, text, userId);
            return;
          }

          console.log(
            `[Handler] selected tool=${toolResult.toolId}, compiling schema...`,
          );
          const compileResult = await this.intentUseCase.compileSchema({
            manifest: toolResult.manifest,
            messages: [text],
            userId,
            partialParams: {},
          });

          const newSession: OrchestratorSession = {
            stage: "compile",
            conversationId: this.conversations.get(chatId) ?? "",
            messages: [text],
            manifest: toolResult.manifest,
            partialParams: compileResult.params,
            tokenSymbols: compileResult.tokenSymbols,
          };

          if (compileResult.missingQuestion) {
            this.orchestratorSessions.set(chatId, newSession);
            await ctx.reply(compileResult.missingQuestion);
            return;
          }

          await this.resolveTokensAndFinish(ctx, chatId, userId, newSession);
          return;
        }

        // Continuing compile loop
        if (existing.stage === "compile") {
          existing.messages.push(text);
          console.log(
            `[Handler] compile stage, messages=${existing.messages.length}`,
          );

          const compileResult = await this.intentUseCase.compileSchema({
            manifest: existing.manifest,
            messages: existing.messages,
            userId,
            partialParams: existing.partialParams,
          });

          existing.partialParams = {
            ...existing.partialParams,
            ...compileResult.params,
          };
          existing.tokenSymbols = {
            ...existing.tokenSymbols,
            ...compileResult.tokenSymbols,
          };

          if (compileResult.missingQuestion) {
            this.orchestratorSessions.set(chatId, existing);
            await ctx.reply(compileResult.missingQuestion);
            return;
          }

          await this.resolveTokensAndFinish(ctx, chatId, userId, existing);
        }
      } catch (err) {
        console.error("[Handler] error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  private async handleFallbackChat(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    text: string,
    userId: string,
  ): Promise<void> {
    const conversationId = this.conversations.get(chatId);
    console.log(
      `[Handler] fallback chat userId=${userId} conversationId=${conversationId ?? "new"}`,
    );
    const response = await this.assistantUseCase.chat({
      userId,
      conversationId,
      message: text,
    });
    this.conversations.set(chatId, response.conversationId);
    console.log(
      `[Handler] fallback chat done toolsUsed=[${response.toolsUsed.join(", ")}]`,
    );
    await this.safeSend(ctx, response.reply);
  }

  private async resolveTokensAndFinish(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const chainId = this.chainId;
    let fromCandidates: ITokenRecord[] = [];
    let toCandidates: ITokenRecord[] = [];

    if (session.tokenSymbols.from) {
      fromCandidates = await this.intentUseCase!.searchTokens(
        session.tokenSymbols.from,
        chainId,
      );
      console.log(
        `[Handler] fromToken "${session.tokenSymbols.from}" candidates: ${fromCandidates.length}`,
      );
      if (fromCandidates.length === 0) {
        await ctx.reply(
          `Token not found: ${session.tokenSymbols.from}. Make sure it is supported on this chain.`,
        );
        this.orchestratorSessions.delete(chatId);
        return;
      }
    }

    if (session.tokenSymbols.to) {
      toCandidates = await this.intentUseCase!.searchTokens(
        session.tokenSymbols.to,
        chainId,
      );
      console.log(
        `[Handler] toToken "${session.tokenSymbols.to}" candidates: ${toCandidates.length}`,
      );
      if (toCandidates.length === 0) {
        await ctx.reply(
          `Token not found: ${session.tokenSymbols.to}. Make sure it is supported on this chain.`,
        );
        this.orchestratorSessions.delete(chatId);
        return;
      }
    }

    const resolvedFrom =
      fromCandidates.length === 1 ? fromCandidates[0]! : null;
    const resolvedTo = toCandidates.length === 1 ? toCandidates[0]! : null;

    if (fromCandidates.length > 1) {
      session.stage = "token_disambig";
      session.disambiguation = {
        resolvedFrom: null,
        resolvedTo: null,
        awaitingSlot: "from",
        fromCandidates,
        toCandidates,
      };
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(
        this.buildDisambiguationPrompt(
          "from",
          session.tokenSymbols.from!,
          fromCandidates,
        ),
      );
      return;
    }

    if (toCandidates.length > 1) {
      session.stage = "token_disambig";
      session.disambiguation = {
        resolvedFrom,
        resolvedTo: null,
        awaitingSlot: "to",
        fromCandidates,
        toCandidates,
      };
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(
        this.buildDisambiguationPrompt(
          "to",
          session.tokenSymbols.to!,
          toCandidates,
        ),
      );
      return;
    }

    await this.buildAndShowConfirmation(
      ctx,
      chatId,
      userId,
      session,
      resolvedFrom,
      resolvedTo,
    );
  }

  private async handleDisambiguationReply(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    text: string,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const pending = session.disambiguation;
    if (!pending) {
      this.orchestratorSessions.delete(chatId);
      await ctx.reply("Session error. Please start over.");
      return;
    }
    const candidates =
      pending.awaitingSlot === "from"
        ? pending.fromCandidates
        : pending.toCandidates;

    console.log(
      `[Handler] disambig reply slot=${pending.awaitingSlot} input="${text}" candidates=[${candidates.map((c) => c.symbol).join(", ")}]`,
    );

    let selected: ITokenRecord | undefined;
    const index = parseInt(text, 10);
    if (!isNaN(index) && index >= 1 && index <= candidates.length) {
      selected = candidates[index - 1];
    } else {
      const normalized = text.trim().toUpperCase();
      selected = candidates.find((c) => c.symbol.toUpperCase() === normalized);
    }

    if (!selected) {
      this.orchestratorSessions.delete(chatId);
      await ctx.reply("Disambiguation cancelled. Please repeat your request.");
      return;
    }

    console.log(
      `[Handler] disambig resolved slot=${pending.awaitingSlot} → ${selected.symbol} (${selected.address})`,
    );

    if (pending.awaitingSlot === "from") {
      pending.resolvedFrom = selected;
      if (pending.toCandidates.length > 1) {
        pending.awaitingSlot = "to";
        this.orchestratorSessions.set(chatId, session);
        await ctx.reply(
          this.buildDisambiguationPrompt(
            "to",
            session.tokenSymbols.to!,
            pending.toCandidates,
          ),
        );
        return;
      }
      pending.resolvedTo = pending.toCandidates[0] ?? null;
    } else {
      pending.resolvedTo = selected;
    }

    await this.buildAndShowConfirmation(
      ctx,
      chatId,
      userId,
      session,
      pending.resolvedFrom,
      pending.resolvedTo,
    );
  }

  private async buildAndShowConfirmation(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
    resolvedFrom: ITokenRecord | null,
    resolvedTo: ITokenRecord | null,
  ): Promise<void> {
    try {
      const calldata = await this.intentUseCase!.buildRequestBody({
        manifest: session.manifest,
        params: session.partialParams,
        resolvedFrom,
        resolvedTo,
        userId,
        amountHuman: session.partialParams.amountHuman as string | undefined,
      });
      this.orchestratorSessions.delete(chatId);
      await this.safeSend(
        ctx,
        this.buildConfirmationMessage(
          session,
          calldata,
          resolvedFrom,
          resolvedTo,
        ),
      );
    } catch (err) {
      console.error("[Handler] buildRequestBody error:", err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(
        `Could not build transaction: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildConfirmationMessage(
    session: OrchestratorSession,
    calldata: { to: string; data: string; value: string },
    fromToken: ITokenRecord | null,
    toToken: ITokenRecord | null,
  ): string {
    const { manifest, partialParams } = session;
    const lines = ["*Intent confirmed*", ""];

    lines.push(`Action: ${manifest.name}`);
    lines.push(`Protocol: ${manifest.protocolName}`);

    if (fromToken) {
      lines.push(`From: ${fromToken.symbol} (${fromToken.name})`);
      lines.push(`  Address: \`${fromToken.address}\``);
      lines.push(`  Decimals: ${fromToken.decimals}`);
      const amountHuman = partialParams.amountHuman as string | undefined;
      if (amountHuman) {
        const raw = toRaw(amountHuman, fromToken.decimals);
        lines.push(`  Amount: ${amountHuman} ${fromToken.symbol} (${raw} raw)`);
      }
    }

    if (toToken) {
      lines.push(`To: ${toToken.symbol} (${toToken.name})`);
      lines.push(`  Address: \`${toToken.address}\``);
      lines.push(`  Decimals: ${toToken.decimals}`);
    }

    lines.push("", "*Calldata*");
    lines.push(`To: \`${calldata.to}\``);
    lines.push(`Value: ${calldata.value}`);
    lines.push(`\`\`\`\n${calldata.data}\n\`\`\``);

    lines.push(
      "",
      `\`\`\`json\n${JSON.stringify(partialParams, null, 2)}\n\`\`\``,
    );
    lines.push("", "Type /confirm to execute or /cancel to abort.");

    return lines.join("\n");
  }

  private buildDisambiguationPrompt(
    slot: "from" | "to",
    symbol: string,
    candidates: ITokenRecord[],
  ): string {
    const label = slot === "from" ? "source token" : "destination token";
    const lines = [
      `Multiple tokens found for "${symbol}" (${label}). Which one do you mean?`,
      "",
    ];
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i]!;
      const addr = t.address.slice(0, 6) + "..." + t.address.slice(-4);
      lines.push(
        `${i + 1}. ${t.symbol} — ${t.name} — ${addr} (${t.decimals} decimals)`,
      );
    }
    lines.push("", "Reply with the number.");
    return lines.join("\n");
  }

  private async confirmLatestIntent(userId: string): Promise<string> {
    if (!this.intentUseCase) return "Intent execution not configured.";
    // The intentUseCase internally looks up the latest AWAITING_CONFIRMATION intent
    // when the sentinel "__latest__" is passed as the intentId.
    const result = await this.intentUseCase.confirmAndExecute({
      intentId: "__latest__",
      userId,
    });
    return result.humanSummary;
  }

  private async fetchPortfolio(userId: string): Promise<string> {
    if (!this.portfolioUseCase) {
      return "Portfolio service not configured.";
    }
    const result = await this.portfolioUseCase.getPortfolio(userId);
    if (!result) {
      return "No Smart Contract Account found. Please complete registration.";
    }

    const rows: string[] = [
      "💼 Portfolio",
      `SCA: \`${result.smartAccountAddress}\``,
      "",
      "Token | Balance",
      "------|-------",
    ];
    for (const b of result.balances) {
      rows.push(`${b.symbol} | ${b.balance}`);
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
