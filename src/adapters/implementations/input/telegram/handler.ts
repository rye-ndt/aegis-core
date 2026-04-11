import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import {
  MissingFieldsError,
  ConversationLimitError,
  InvalidFieldError,
  type ParseFromHistoryResult,
  type ITokenRecord,
  type ToolManifest,
} from "../../../../use-cases/interface/input/intent.interface";
import type { IntentPackage } from "../../../../use-cases/interface/output/intentParser.interface";

// BigInt string arithmetic — no float precision loss at any decimal count
function toRaw(amountHuman: string, decimals: number): string {
  const [intPart, fracPart = ""] = amountHuman.split(".");
  const padded = fracPart.padEnd(decimals, "0").slice(0, decimals);
  const scale = 10n ** BigInt(decimals);
  const raw = BigInt(intPart) * scale + BigInt(padded || "0");
  return raw.toString();
}

interface DisambiguationPending {
  intent: IntentPackage;
  resolvedFrom: ITokenRecord | null;
  resolvedTo: ITokenRecord | null;
  awaitingSlot: "from" | "to";
  fromCandidates: ITokenRecord[];
  toCandidates: ITokenRecord[];
  manifest?: ToolManifest;
}

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private sessionCache = new Map<
    number,
    { userId: string; expiresAtEpoch: number }
  >();
  private intentHistory = new Map<number, string[]>();
  private tokenDisambiguation = new Map<number, DisambiguationPending>();

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly authUseCase: IAuthUseCase,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly botToken?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly portfolioUseCase?: IPortfolioUseCase,
  ) {}

  register(bot: Bot): void {
    bot.catch((err) => {
      console.error("Bot error:", err.message);
      if (err.error) console.error("Cause:", err.error);
    });

    bot.command("start", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        const keyboard = new InlineKeyboard().text("Sign in with Google", "auth:login");
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
        await ctx.reply("Authenticated with Google via Privy. You can now use the Onchain Agent.");
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
      this.tokenDisambiguation.delete(ctx.chat.id);
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
        await ctx.reply("Authenticated with Google. You can now use the Onchain Agent.");
      } catch {
        await ctx.reply("Authentication failed. Please try again from the mini app.");
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
      // Step 1: Require a valid session before doing anything
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

      console.log(
        `[Handler] message received chatId=${chatId} userId=${session.userId} text="${text}"`,
      );

      try {
        // Step 2: If the user is mid-disambiguation (choosing between token matches),
        //         route to that handler and stop — no intent parsing needed
        if (this.tokenDisambiguation.has(chatId)) {
          console.log(
            `[Handler] disambiguation active for chatId=${chatId}, routing to disambiguationReply`,
          );
          await this.handleDisambiguationReply(
            ctx,
            chatId,
            text,
            session.userId,
          );
          return;
        }

        // Step 3: Accumulate the message into history and attempt to parse a
        //         structured intent. Throws MissingFieldsError / InvalidFieldError
        //         when the intent is incomplete, or ConversationLimitError when
        //         the conversation has gone on too long without resolving.
        console.log(`[Handler] parsing intent from history...`);
        const { intent, manifest } = await this.parseIntentWithHistory(
          chatId,
          text,
          session.userId,
        );
        console.log(
          `[Handler] intent parsed: ${intent === null ? "null (no on-chain action)" : `action=${intent.action} confidence=${intent.confidence}`}${manifest ? ` manifest=${manifest.toolId}` : ""}`,
        );

        // Step 4: Route on whether the parser extracted a structured intent
        if (intent === null) {
          // No on-chain action detected — fall back to conversational assistant
          console.log(`[Handler] routing to fallback chat`);
          await this.handleFallbackChat(ctx, chatId, text, session.userId);
        } else {
          // Structured intent found — resolve token addresses and show confirmation
          console.log(
            `[Handler] routing to token resolution fromToken="${intent.fromTokenSymbol}" toToken="${intent.toTokenSymbol}"`,
          );
          await this.startTokenResolution(ctx, chatId, intent, manifest);
        }
      } catch (err) {
        if (err instanceof ConversationLimitError) {
          await ctx.reply(err.message);
          return;
        }
        if (
          err instanceof MissingFieldsError ||
          err instanceof InvalidFieldError
        ) {
          await ctx.reply(err.prompt);
          return;
        }
        console.error("Error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  /**
   * Appends the incoming message to this chat's history, then delegates to the
   * intent use case which discovers relevant manifests, parses the intent, and
   * validates completeness. Clears the history on success.
   *
   * Throws ConversationLimitError, MissingFieldsError, or InvalidFieldError —
   * callers are expected to handle each case with an appropriate user reply.
   */
  private async parseIntentWithHistory(
    chatId: number,
    text: string,
    userId: string,
  ): Promise<ParseFromHistoryResult> {
    const history = this.intentHistory.get(chatId) ?? [];
    history.push(text);
    this.intentHistory.set(chatId, history);

    try {
      const result = await this.intentUseCase!.parseFromHistory(history, userId);
      // Intent resolved — clear history for the next intent
      this.intentHistory.delete(chatId);
      return result;
    } catch (err) {
      if (err instanceof ConversationLimitError) {
        // Conversation exceeded the allowed turn limit — reset so next message starts fresh
        this.intentHistory.delete(chatId);
      }
      throw err;
    }
  }

  /**
   * Handles messages that carried no structured on-chain intent.
   * Forwards the text to the conversational assistant and tracks the
   * conversation ID so follow-up messages maintain context.
   */
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
      `[Handler] fallback chat done toolsUsed=[${response.toolsUsed.join(", ")}] replyLength=${response.reply.length}`,
    );
    await this.safeSend(ctx, response.reply);
  }

  private async startTokenResolution(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    intent: IntentPackage,
    manifest?: ToolManifest,
  ): Promise<void> {
    if (!this.intentUseCase) {
      await ctx.reply("Token registry not configured.");
      return;
    }

    const chainId = parseInt(process.env.CHAIN_ID ?? "43113", 10);
    let fromCandidates: ITokenRecord[] = [];
    let toCandidates: ITokenRecord[] = [];

    if (intent.fromTokenSymbol) {
      console.log(
        `[Handler] searching token registry for fromToken="${intent.fromTokenSymbol}" chainId=${chainId}`,
      );
      fromCandidates = await this.intentUseCase.searchTokens(
        intent.fromTokenSymbol,
        chainId,
      );
      console.log(
        `[Handler] fromToken candidates: ${fromCandidates.length} — ${fromCandidates.map((t) => t.symbol).join(", ") || "none"}`,
      );
      if (fromCandidates.length === 0) {
        await ctx.reply(
          `Token not found: ${intent.fromTokenSymbol}. Make sure the token is supported on this chain.`,
        );
        return;
      }
    }

    if (intent.toTokenSymbol) {
      console.log(
        `[Handler] searching token registry for toToken="${intent.toTokenSymbol}" chainId=${chainId}`,
      );
      toCandidates = await this.intentUseCase.searchTokens(
        intent.toTokenSymbol,
        chainId,
      );
      console.log(
        `[Handler] toToken candidates: ${toCandidates.length} — ${toCandidates.map((t) => t.symbol).join(", ") || "none"}`,
      );
      if (toCandidates.length === 0) {
        await ctx.reply(
          `Token not found: ${intent.toTokenSymbol}. Make sure the token is supported on this chain.`,
        );
        return;
      }
    }

    const resolvedFrom = fromCandidates.length === 1 ? fromCandidates[0] : null;
    const resolvedTo = toCandidates.length === 1 ? toCandidates[0] : null;
    console.log(
      `[Handler] token resolution — from=${resolvedFrom?.symbol ?? "ambiguous/null"} to=${resolvedTo?.symbol ?? "ambiguous/null"}`,
    );

    if (fromCandidates.length > 1) {
      console.log(`[Handler] fromToken ambiguous, starting disambiguation`);
      this.tokenDisambiguation.set(chatId, {
        intent,
        resolvedFrom: null,
        resolvedTo: null,
        awaitingSlot: "from",
        fromCandidates,
        toCandidates,
        manifest,
      });
      await ctx.reply(
        this.buildDisambiguationPrompt(
          "from",
          intent.fromTokenSymbol!,
          fromCandidates,
        ),
      );
      return;
    }

    if (toCandidates.length > 1) {
      console.log(`[Handler] toToken ambiguous, starting disambiguation`);
      this.tokenDisambiguation.set(chatId, {
        intent,
        resolvedFrom,
        resolvedTo: null,
        awaitingSlot: "to",
        fromCandidates,
        toCandidates,
        manifest,
      });
      await ctx.reply(
        this.buildDisambiguationPrompt(
          "to",
          intent.toTokenSymbol!,
          toCandidates,
        ),
      );
      return;
    }

    await this.safeSend(
      ctx,
      await this.buildEnrichedMessage(
        intent,
        resolvedFrom,
        resolvedTo,
        manifest,
      ),
    );
  }

  private async handleDisambiguationReply(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    text: string,
    _userId: string,
  ): Promise<void> {
    const pending = this.tokenDisambiguation.get(chatId)!;
    const candidates =
      pending.awaitingSlot === "from"
        ? pending.fromCandidates
        : pending.toCandidates;

    console.log(
      `[Handler] disambiguation reply chatId=${chatId} slot=${pending.awaitingSlot} input="${text}" candidates=[${candidates.map((c) => c.symbol).join(", ")}]`,
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
      console.log(
        `[Handler] disambiguation failed — no match for "${text}", cancelling`,
      );
      this.tokenDisambiguation.delete(chatId);
      await ctx.reply("Disambiguation cancelled. Please repeat your request.");
      return;
    }
    console.log(
      `[Handler] disambiguation resolved slot=${pending.awaitingSlot} → ${selected.symbol} (${selected.address})`,
    );

    if (pending.awaitingSlot === "from") {
      pending.resolvedFrom = selected;
      if (pending.toCandidates.length > 1) {
        pending.awaitingSlot = "to";
        this.tokenDisambiguation.set(chatId, pending);
        await ctx.reply(
          this.buildDisambiguationPrompt(
            "to",
            pending.intent.toTokenSymbol!,
            pending.toCandidates,
          ),
        );
        return;
      } else {
        pending.resolvedTo = pending.toCandidates[0] ?? null;
      }
    } else {
      pending.resolvedTo = selected;
    }

    this.tokenDisambiguation.delete(chatId);
    await this.safeSend(
      ctx,
      await this.buildEnrichedMessage(
        pending.intent,
        pending.resolvedFrom,
        pending.resolvedTo,
        pending.manifest,
      ),
    );
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
      const t = candidates[i];
      const addr = t.address.slice(0, 6) + "..." + t.address.slice(-4);
      lines.push(
        `${i + 1}. ${t.symbol} — ${t.name} — ${addr} (${t.decimals} decimals)`,
      );
    }
    lines.push("", "Reply with the number.");
    return lines.join("\n");
  }

  private async buildEnrichedMessage(
    intent: IntentPackage,
    fromToken: ITokenRecord | null,
    toToken: ITokenRecord | null,
    manifest?: ToolManifest,
  ): Promise<string> {
    const lines = ["*Intent confirmed*", ""];
    lines.push(`Action: ${intent.action}`);

    if (fromToken) {
      lines.push(`From: ${fromToken.symbol} (${fromToken.name})`);
      lines.push(`  Address: \`${fromToken.address}\``);
      lines.push(`  Decimals: ${fromToken.decimals}`);
      if (intent.amountHuman) {
        // BigInt arithmetic to avoid float precision loss on 18-decimal tokens
        const raw = toRaw(intent.amountHuman, fromToken.decimals);
        lines.push(
          `  Amount: ${intent.amountHuman} ${fromToken.symbol} (${raw} raw)`,
        );
      }
    }

    if (toToken) {
      lines.push(`To: ${toToken.symbol} (${toToken.name})`);
      lines.push(`  Address: \`${toToken.address}\``);
      lines.push(`  Decimals: ${toToken.decimals}`);
    }

    if (intent.slippageBps !== undefined) {
      lines.push(`Slippage: ${intent.slippageBps / 100}%`);
    }

    if (manifest) {
      lines.push("", "*Tool matched*");
      lines.push(`Name: ${manifest.name}`);
      lines.push(`Protocol: ${manifest.protocolName}`);
      lines.push(`Category: ${manifest.category}`);
      lines.push(`Description: ${manifest.description}`);

      // Build calldata preview via the use case (keeps ManifestDrivenSolver in the adapter layer)
      const amountRaw =
        fromToken && intent.amountHuman
          ? toRaw(intent.amountHuman, fromToken.decimals)
          : undefined;
      const enrichedIntent: IntentPackage = {
        ...intent,
        params: {
          ...(intent.params ?? {}),
          ...(fromToken && { tokenAddress: fromToken.address }),
          ...(amountRaw !== undefined && { amountRaw }),
        },
      };
      const calldata = await this.intentUseCase?.previewCalldata(enrichedIntent, manifest);
      if (calldata) {
        lines.push("", "*Calldata*");
        lines.push(`To: \`${calldata.to}\``);
        lines.push(`Value: ${calldata.value}`);
        lines.push(`\`\`\`\n${calldata.data}\n\`\`\``);
      } else {
        lines.push("", "_Calldata preview unavailable_");
      }
    } else {
      lines.push("", "_No tool manifest found in registry for this action._");
    }

    lines.push("", `\`\`\`json\n${JSON.stringify(intent, null, 2)}\n\`\`\``);

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
