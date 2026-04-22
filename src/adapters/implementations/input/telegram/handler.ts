import type { Bot } from "grammy";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import { InlineKeyboard } from "grammy";
import { toRaw } from "../../../../helpers/bigint";
import {
  INTENT_COMMAND,
  parseIntentCommand,
} from "../../../../helpers/enums/intentCommand.enum";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { USER_INTENT_TYPE } from "../../../../helpers/enums/userIntentType.enum";
import { ZERODEV_MESSAGE_TYPE } from "../../../../helpers/enums/zerodevMessageType.enum";
import { extractAddressFields } from "../../../../helpers/schema/addressFields";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import {
  type ITokenRecord,
  type ResolvedPayload,
  type ToolManifest,
  DisambiguationRequiredError,
} from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { IDelegationRequestBuilder } from "../../../../use-cases/interface/output/delegation/delegationRequestBuilder.interface";
import type { ZerodevMessage } from "../../../../use-cases/interface/output/delegation/zerodevMessage.types";
import type { IPrivyAuthService } from "../../../../use-cases/interface/output/privyAuth.interface";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IResolverEngine } from "../../../../use-cases/interface/output/resolver.interface";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";
import type { ITokenDelegationDB } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IExecutionEstimator } from "../../../../use-cases/interface/output/executionEstimator.interface";

// ── Session state types ────────────────────────────────────────────────────────

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
  /** Legacy: token symbols extracted by the LLM for non-dual-schema tools. */
  tokenSymbols: { from?: string; to?: string };
  /** Dual-schema: human-readable values keyed by RESOLVER_FIELD enum — fed to ResolverEngine. */
  resolverFields: Partial<Record<string, string>>;
  /** Counts LLM extraction turns; aborts at MAX_TOOL_ROUNDS. */
  compileTurns: number;
  /** Counts disambiguation reply attempts; aborts at 10. */
  disambigTurns: number;
  /** Populated after Phase 3 resolution; consumed in Phase 4. */
  resolved?: ResolvedPayload;
  disambiguation?: DisambiguationPending;
  recipientTelegramUserId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the message clearly expresses a fiat / stablecoin amount
 * that a non-crypto user would write, e.g.:
 *   "send @alice $5"  |  "send @bob 5 dollars"  |  "send @charlie 5 bucks"
 *   "pay @dave 10 usd"  |  "transfer 3.50 usdc to @eve"
 *
 * When detected and no explicit token symbol was extracted by the LLM,
 * the handler automatically injects USDC as the source token so the user
 * never has to be asked which stablecoin they meant.
 */
function detectStablecoinIntent(text: string): boolean {
  // Matches:
  //   $N  |  $N.NN
  //   N dollar | N dollars
  //   N buck   | N bucks
  //   N usd    | N usdc   (case-insensitive)
  const FIAT_PATTERN =
    /\$\s*\d+(\.\d+)|(\d+(\.\d+)?)\s*(dollars?|bucks?|usdc?)\b/i;
  return FIAT_PATTERN.test(text);
}

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private sessionCache = new Map<
    number,
    { userId: string; expiresAtEpoch: number }
  >();
  private orchestratorSessions = new Map<number, OrchestratorSession>();
  private pendingRecipientNotifications = new Map<
    string,
    { telegramUserId: string }
  >();
  private botRef: Bot | null = null;

  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly authUseCase: IAuthUseCase,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly botToken?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly portfolioUseCase?: IPortfolioUseCase,
    private readonly chainId: number = CHAIN_CONFIG.chainId,
    private readonly userProfileRepo?: IUserProfileDB,
    private readonly pendingDelegationRepo?: IPendingDelegationDB,
    private readonly delegationBuilder?: IDelegationRequestBuilder,
    private readonly telegramHandleResolver?: ITelegramHandleResolver,
    private readonly privyAuthService?: IPrivyAuthService,
    private readonly signingRequestUseCase?: ISigningRequestUseCase,
    private readonly resolverEngine?: IResolverEngine,
    private readonly tokenDelegationDB?: ITokenDelegationDB,
    private readonly executionEstimator?: IExecutionEstimator,
  ) {}

  // ── Bot registration ─────────────────────────────────────────────────────────

  private async sendWelcomeWithLoginButton(chatId: number): Promise<void> {
    const miniAppUrl = process.env.MINI_APP_URL;
    const keyboard = miniAppUrl
      ? new InlineKeyboard().webApp("Open Aegis", miniAppUrl)
      : new InlineKeyboard().text("Sign in with Google", "auth:login");
    await this.botRef!.api.sendMessage(
      chatId,
      "Welcome to the Onchain Agent.\n\nSign in with Google via the Aegis mini app to get started.",
      { reply_markup: keyboard },
    );
  }

  register(bot: Bot): void {
    this.botRef = bot;

    bot.catch((err) => {
      console.error("Bot error:", err.message);
      if (err.error) console.error("Cause:", err.error);
    });

    bot.command("start", async (ctx) => {
      const session = await this.ensureAuthenticated(ctx.chat.id);
      if (!session) {
        await this.sendWelcomeWithLoginButton(ctx.chat.id);
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

    bot.command("logout", async (ctx) => {
      const chatId = ctx.chat.id;
      await this.telegramSessions.deleteByChatId(String(chatId));
      this.sessionCache.delete(chatId);
      this.conversations.delete(chatId);
      await ctx.reply("Logged out. Your session has been invalidated.");
      await this.sendWelcomeWithLoginButton(chatId);
    });

    // NOTE: Superseded by the optional telegramChatId field in POST /auth/privy.
    // Kept for backward compatibility with Mini App versions that still call sendData.
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
      } catch (err) {
        console.error("[Auth] web_app_data loginWithPrivy failed:", err);
        await ctx.reply(
          "Authentication failed. Please try again from the mini app.",
        );
      }
    });

    // ── Primary text handler ────────────────────────────────────────────────
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

      console.log(
        `[Handler] message chatId=${chatId} userId=${userId} text="${text}"`,
      );

      try {
        const existing = this.orchestratorSessions.get(chatId);

        // ── Disambiguation reply ────────────────────────────────────────────
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

        // ── Phase 1: Routing ────────────────────────────────────────────────
        const command = parseIntentCommand(text);

        if (!existing) {
          if (command) {
            // Command-driven path (new deterministic pipeline)
            console.log(
              `[Handler] command=${command}, starting command session`,
            );
            await this.startCommandSession(ctx, chatId, userId, command, text);
          } else {
            // Legacy free-form text path
            console.log(`[Handler] no session, no command — legacy path`);
            await this.startLegacySession(ctx, chatId, userId, text);
          }
          return;
        }

        // ── Continuing compile loop (Phase 2) ──────────────────────────────
        if (existing.stage === "compile") {
          existing.messages.push(text);
          console.log(
            `[Handler] compile stage, messages=${existing.messages.length}`,
          );
          await this.continueCompileLoop(ctx, chatId, userId, existing);
        }
      } catch (err) {
        console.error("[Handler] error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
  }

  // ── Phase 1 helpers ──────────────────────────────────────────────────────────

  /** Phase 1 — command-driven session start (new deterministic pipeline). */
  private async startCommandSession(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    command: INTENT_COMMAND,
    text: string,
  ): Promise<void> {
    if (!this.intentUseCase) {
      await ctx.reply("Intent service not configured.");
      return;
    }

    // selectTool uses keyword search; the command string (e.g. "/buy") is passed
    // as the intentType query alongside the full message for context.
    const toolResult = await this.intentUseCase.selectTool(
      command as unknown as USER_INTENT_TYPE,
      [text],
    );

    if (!toolResult) {
      await ctx.reply(
        `No tool is registered for ${command}. Contact the admin.`,
      );
      return;
    }

    console.log(
      `[Handler] command=${command} → tool=${toolResult.toolId}, compiling schema...`,
    );

    const compileResult = await this.intentUseCase.compileSchema({
      manifest: toolResult.manifest,
      messages: [text],
      userId,
      partialParams: {},
    });

    // ── Stablecoin auto-detection ─────────────────────────────────────────────
    // Non-crypto users write "$5", "5 dollars", "5 bucks", etc. without naming a
    // token. When detected (and the LLM didn't already extract a from-token),
    // we silently default to USDC so no follow-up question is needed.
    if (
      detectStablecoinIntent(text) &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from
    ) {
      console.log(
        `[Handler] stablecoin intent detected — injecting USDC as fromToken`,
      );
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = {
        ...compileResult.tokenSymbols,
        from: "USDC",
      };
    }

    const newSession: OrchestratorSession = {
      stage: "compile",
      conversationId: this.conversations.get(chatId) ?? "",
      messages: [text],
      manifest: toolResult.manifest,
      partialParams: compileResult.params,
      tokenSymbols: compileResult.tokenSymbols,
      resolverFields: compileResult.resolverFields ?? {},
      compileTurns: 1,
      disambigTurns: 0,
    };

    if (compileResult.telegramHandle && !newSession.recipientTelegramUserId) {
      const resolved = await this.resolveRecipientHandle(
        ctx,
        chatId,
        compileResult.telegramHandle,
        newSession,
      );
      if (!resolved) return;
    }

    if (compileResult.missingQuestion) {
      this.orchestratorSessions.set(chatId, newSession);
      await ctx.reply(compileResult.missingQuestion);
      return;
    }

    await this.finishCompileOrResolve(ctx, chatId, userId, newSession);
  }

  /** Phase 1 — free-form text session start (legacy classify→compile path). */
  private async startLegacySession(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    text: string,
  ): Promise<void> {
    if (!this.intentUseCase) {
      await ctx.reply("Intent service not configured.");
      return;
    }

    const intentType = await this.intentUseCase.classifyIntent([text]);
    console.log(`[Handler] intentType=${intentType}`);

    if (
      intentType === USER_INTENT_TYPE.RETRIEVE_BALANCE ||
      intentType === USER_INTENT_TYPE.UNKNOWN
    ) {
      await this.handleFallbackChat(ctx, chatId, text, userId);
      return;
    }

    const toolResult = await this.intentUseCase.selectTool(intentType, [text]);
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

    // ── Stablecoin auto-detection ─────────────────────────────────────────────
    if (
      detectStablecoinIntent(text) &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from
    ) {
      console.log(
        `[Handler] stablecoin intent detected — injecting USDC as fromToken`,
      );
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = {
        ...compileResult.tokenSymbols,
        from: "USDC",
      };
    }

    const newSession: OrchestratorSession = {
      stage: "compile",
      conversationId: this.conversations.get(chatId) ?? "",
      messages: [text],
      manifest: toolResult.manifest,
      partialParams: compileResult.params,
      tokenSymbols: compileResult.tokenSymbols,
      resolverFields: compileResult.resolverFields ?? {},
      compileTurns: 1,
      disambigTurns: 0,
    };

    if (compileResult.telegramHandle && !newSession.recipientTelegramUserId) {
      const resolved = await this.resolveRecipientHandle(
        ctx,
        chatId,
        compileResult.telegramHandle,
        newSession,
      );
      if (!resolved) return;
    }

    if (compileResult.missingQuestion) {
      this.orchestratorSessions.set(chatId, newSession);
      await ctx.reply(compileResult.missingQuestion);
      return;
    }

    await this.finishCompileOrResolve(ctx, chatId, userId, newSession);
  }

  // ── Phase 2 — LLM extraction loop ───────────────────────────────────────────

  private async continueCompileLoop(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const MAX_COMPILE_TURNS = parseInt(process.env.MAX_TOOL_ROUNDS ?? "10", 10);

    if (session.compileTurns >= MAX_COMPILE_TURNS) {
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(
        "I couldn't collect all required information after several attempts. Please start over with a new request.",
      );
      return;
    }

    session.compileTurns += 1;

    const compileResult = await this.intentUseCase!.compileSchema({
      manifest: session.manifest,
      messages: session.messages,
      userId,
      partialParams: session.partialParams,
    });

    // ── Stablecoin auto-detection ─────────────────────────────────────────────
    // Check the full message history: the user may have said "$5" in an earlier
    // turn that is now being continued. Detection is therefore sticky.
    const anyFiatMessage = session.messages.some(detectStablecoinIntent);
    if (
      anyFiatMessage &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !session.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from &&
      !session.tokenSymbols.from
    ) {
      console.log(
        `[Handler] stablecoin intent detected (history) — injecting USDC as fromToken`,
      );
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = {
        ...compileResult.tokenSymbols,
        from: "USDC",
      };
    }

    session.partialParams = {
      ...session.partialParams,
      ...compileResult.params,
    };
    session.tokenSymbols = {
      ...session.tokenSymbols,
      ...compileResult.tokenSymbols,
    };
    session.resolverFields = {
      ...session.resolverFields,
      ...(compileResult.resolverFields ?? {}),
    };

    if (compileResult.telegramHandle && !session.recipientTelegramUserId) {
      const resolved = await this.resolveRecipientHandle(
        ctx,
        chatId,
        compileResult.telegramHandle,
        session,
      );
      if (!resolved) return;
    }

    if (compileResult.missingQuestion) {
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(compileResult.missingQuestion);
      return;
    }

    await this.finishCompileOrResolve(ctx, chatId, userId, session);
  }

  // ── Phase 2→3 transition ─────────────────────────────────────────────────────

  private async finishCompileOrResolve(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const missing = this.getMissingRequiredFields(
      session.manifest,
      session.partialParams,
    );
    if (missing.length > 0) {
      console.log(
        `[Handler] post-compile validation: missing fields=${JSON.stringify(missing)}`,
      );
      const question = await this.intentUseCase!.generateMissingParamQuestion(
        session.manifest,
        missing,
      );
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(question);
      return;
    }

    // Choose Phase 3 path: dual-schema (resolver engine) or legacy (token symbols)
    const usesDualSchema =
      session.manifest.requiredFields !== undefined &&
      Object.keys(session.manifest.requiredFields).length > 0 &&
      this.resolverEngine !== undefined;

    if (usesDualSchema) {
      console.log(`[Handler] dual-schema path → runResolutionPhase`);
      await this.runResolutionPhase(ctx, chatId, userId, session);
    } else {
      console.log(`[Handler] legacy path → resolveTokensAndFinish`);
      await this.resolveTokensAndFinish(ctx, chatId, userId, session);
    }
  }

  // ── Phase 3 — Dual-schema resolver path ─────────────────────────────────────

  private async runResolutionPhase(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    try {
      const resolved = await this.resolverEngine!.resolve({
        resolverFields: session.resolverFields,
        userId,
        chainId: this.chainId,
      });
      session.resolved = resolved;

      if (resolved.recipientTelegramUserId) {
        session.recipientTelegramUserId = resolved.recipientTelegramUserId;
      }

      console.log(
        `[Handler] resolution complete fromToken=${resolved.fromToken?.symbol ?? "null"} toToken=${resolved.toToken?.symbol ?? "null"} rawAmount=${resolved.rawAmount}`,
      );

      await this.buildAndShowConfirmationFromResolved(
        ctx,
        chatId,
        userId,
        session,
      );
    } catch (err) {
      if (err instanceof DisambiguationRequiredError) {
        console.log(
          `[Handler] disambiguation required slot=${err.slot} symbol="${err.symbol}" candidates=${err.candidates.length}`,
        );
        await this.enterDisambiguationFromResolver(ctx, chatId, session, err);
        return;
      }
      this.orchestratorSessions.delete(chatId);
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Could not resolve transaction details: ${msg}`);
    }
  }

  private async enterDisambiguationFromResolver(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    session: OrchestratorSession,
    err: DisambiguationRequiredError,
  ): Promise<void> {
    session.stage = "token_disambig";
    session.disambiguation = {
      resolvedFrom:
        err.slot === "to" ? (session.resolved?.fromToken ?? null) : null,
      resolvedTo:
        err.slot === "from" ? (session.resolved?.toToken ?? null) : null,
      awaitingSlot: err.slot,
      fromCandidates: err.slot === "from" ? err.candidates : [],
      toCandidates: err.slot === "to" ? err.candidates : [],
    };
    this.orchestratorSessions.set(chatId, session);
    await ctx.reply(
      this.buildDisambiguationPrompt(err.slot, err.symbol, err.candidates),
    );
  }

  // ── Phase 3 — Disambiguation reply handler ───────────────────────────────────

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

    // Turn-limit guard
    session.disambigTurns += 1;
    if (session.disambigTurns > 10) {
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(
        "Token selection timed out after too many attempts. Please start over.",
      );
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

    // Determine if this session is using the dual-schema resolver path
    const usesDualSchema =
      session.manifest.requiredFields !== undefined &&
      Object.keys(session.manifest.requiredFields).length > 0 &&
      this.resolverEngine !== undefined;

    if (pending.awaitingSlot === "from") {
      pending.resolvedFrom = selected;

      if (usesDualSchema) {
        // Patch resolverFields with the confirmed address for an exact next lookup
        session.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] =
          selected.address;
      }

      if (pending.toCandidates.length > 1) {
        pending.awaitingSlot = "to";
        this.orchestratorSessions.set(chatId, session);
        await ctx.reply(
          this.buildDisambiguationPrompt(
            "to",
            session.tokenSymbols.to ?? "",
            pending.toCandidates,
          ),
        );
        return;
      }
      pending.resolvedTo = pending.toCandidates[0] ?? null;
    } else {
      pending.resolvedTo = selected;

      if (usesDualSchema) {
        session.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] =
          selected.address;
      }
    }

    // All disambiguation done — clear disambig state
    session.disambiguation = undefined;
    session.stage = "compile"; // prevent re-entering disambig handler

    if (usesDualSchema) {
      await this.runResolutionPhase(ctx, chatId, userId, session);
    } else {
      await this.buildAndShowConfirmation(
        ctx,
        chatId,
        userId,
        session,
        pending.resolvedFrom,
        pending.resolvedTo,
      );
    }
  }

  // ── Phase 4 — Dual-schema confirmation ──────────────────────────────────────

  private async buildAndShowConfirmationFromResolved(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const { resolved } = session;
    if (!resolved) {
      await ctx.reply(
        "Internal error: resolution payload missing. Please try again.",
      );
      return;
    }

    // Merge resolved values into partialParams so buildRequestBody can use them
    if (resolved.rawAmount)
      session.partialParams.amountRaw = resolved.rawAmount;
    if (resolved.recipientAddress)
      session.partialParams.recipient = resolved.recipientAddress;
    if (resolved.senderAddress)
      session.partialParams.userAddress = resolved.senderAddress;

    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await this.intentUseCase!.buildRequestBody({
        manifest: session.manifest,
        params: session.partialParams,
        resolvedFrom: resolved.fromToken,
        resolvedTo: resolved.toToken,
        userId,
        amountHuman: session.partialParams.amountHuman as string | undefined,
      });
    } catch (err) {
      console.error("[Handler] buildRequestBody failed:", err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(
        `Could not build transaction: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (session.recipientTelegramUserId) {
      this.pendingRecipientNotifications.set(userId, {
        telegramUserId: session.recipientTelegramUserId,
      });
    }

    this.orchestratorSessions.delete(chatId);

    // ── Step A: Skip estimator for native token ────────────────────────────────────
    const fromToken = resolved.fromToken;
    const canCheckDelegation =
      fromToken &&
      !fromToken.isNative &&
      this.tokenDelegationDB &&
      this.executionEstimator;

    if (canCheckDelegation) {
      // ── Step B: Run estimator ───────────────────────────────────────────────
      const delegations =
        await this.tokenDelegationDB!.findActiveByUserId(userId);
      const estimationResult = await this.executionEstimator!.estimate({
        delegations,
        intentTokenAddress: fromToken.address,
        intentTokenSymbol: fromToken.symbol,
        intentAmountRaw: (session.partialParams.amountRaw as string) ?? "0",
        intentAmountHuman: (session.partialParams.amountHuman as string) ?? "0",
      });

      if (!estimationResult.shouldApproveMore) {
        // ── Step C: Sufficient delegation → autonomous execution ──────────────────
        console.log(
          `[Handler] delegation sufficient — pushing auto-sign request to Mini App for userId=${userId}`,
        );
        const { requestId } = await this.signingRequestUseCase!.createRequest({
          userId,
          chatId,
          to: calldata.to,
          value: calldata.value,
          data: calldata.data,
          description: `Autonomous execution for ${session.manifest.name}`,
          autoSign: true,
        });
        await this.safeSend(
          ctx,
          "✅ Check the Aegis mini app to complete the transaction automatically.",
        );
        await this.sendMiniAppButton(ctx as any, requestId, true);
        await this.tryCreateDelegationRequest(ctx, userId, session, fromToken);
        return;
      }

      // ── Step D: Insufficient delegation → re-approval prompt ────────────────
      const amountHumanNum = parseFloat(
        (session.partialParams.amountHuman as string) ?? "0",
      );
      const topUp = Math.max(amountHumanNum, 100);
      const rawForReapproval = (
        BigInt(Math.round(topUp)) *
        10n ** BigInt(fromToken.decimals)
      ).toString();
      const miniAppUrlBase = process.env.MINI_APP_URL ?? "";
      const reapprovalUrl = `${miniAppUrlBase}?reapproval=1&tokenAddress=${encodeURIComponent(fromToken.address)}&amountRaw=${rawForReapproval}`;
      const keyboard = new InlineKeyboard().webApp(
        "Approve More",
        reapprovalUrl,
      );
      await ctx.reply(estimationResult.displayMessage, {
        reply_markup: keyboard,
      });
      return;
    }

    // ── Fallback: show confirmation message (native or estimator not configured) ──
    // Phase 4: show finalSchema (if defined) or fall back to legacy format
    if (session.manifest.finalSchema) {
      const finalSchemaFilled = this.populateFinalSchema(
        session.manifest.finalSchema,
        resolved,
        session.partialParams,
      );
      await this.safeSend(
        ctx,
        this.buildFinalSchemaConfirmation(session, finalSchemaFilled, calldata),
      );
    } else {
      await this.safeSend(
        ctx,
        this.buildConfirmationMessage(
          session,
          calldata,
          resolved.fromToken,
          resolved.toToken,
        ),
      );
    }

    await this.sendMiniAppButton(ctx, undefined);
    await this.tryCreateDelegationRequest(
      ctx,
      userId,
      session,
      resolved.fromToken,
    );
  }

  private populateFinalSchema(
    finalSchema: Record<string, unknown>,
    resolved: ResolvedPayload,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const filled: Record<string, unknown> = {};
    const properties = (finalSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;

    for (const key of Object.keys(properties)) {
      if (key === "from_token_address" && resolved.fromToken)
        filled[key] = resolved.fromToken.address;
      else if (key === "to_token_address" && resolved.toToken)
        filled[key] = resolved.toToken.address;
      else if (key === "raw_amount" && resolved.rawAmount)
        filled[key] = resolved.rawAmount;
      else if (key === "recipient_address" && resolved.recipientAddress)
        filled[key] = resolved.recipientAddress;
      else if (key === "sender_address" && resolved.senderAddress)
        filled[key] = resolved.senderAddress;
      else if (params[key] !== undefined) filled[key] = params[key];
    }

    return filled;
  }

  private buildFinalSchemaConfirmation(
    session: OrchestratorSession,
    finalSchema: Record<string, unknown>,
    calldata: { to: string; data: string; value: string },
  ): string {
    const lines = [
      "*Transaction Preview*",
      "",
      `Action: ${session.manifest.name}`,
      `Protocol: ${session.manifest.protocolName}`,
      "",
      "*Resolved Parameters:*",
      "```json",
      JSON.stringify(finalSchema, null, 2),
      "```",
      "",
      "*Calldata*",
      `To: \`${calldata.to}\``,
      `Value: ${calldata.value}`,
      `\`\`\`\n${calldata.data}\n\`\`\``,
      "",
      "Open the Aegis app to review and sign this transaction.",
    ];
    return lines.join("\n");
  }

  // ── Phase 3 — Legacy token-resolution path (unchanged logic) ────────────────

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

  // ── Phase 4 — Legacy confirmation path (unchanged logic) ────────────────────

  private async buildAndShowConfirmation(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    userId: string,
    session: OrchestratorSession,
    resolvedFrom: ITokenRecord | null,
    resolvedTo: ITokenRecord | null,
  ): Promise<void> {
    const amountHuman = session.partialParams.amountHuman as string | undefined;

    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await this.intentUseCase!.buildRequestBody({
        manifest: session.manifest,
        params: session.partialParams,
        resolvedFrom,
        resolvedTo,
        userId,
        amountHuman,
      });
    } catch (err) {
      console.error("[Handler] buildRequestBody failed:", err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(
        `Could not build transaction: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (session.recipientTelegramUserId) {
      this.pendingRecipientNotifications.set(userId, {
        telegramUserId: session.recipientTelegramUserId,
      });
    }

    this.orchestratorSessions.delete(chatId);

    // ── Step A: Skip estimator for native token ────────────────────────────────────
    const canCheckDelegation =
      resolvedFrom &&
      !resolvedFrom.isNative &&
      this.tokenDelegationDB &&
      this.executionEstimator;

    if (canCheckDelegation) {
      // ── Step B: Run estimator ───────────────────────────────────────────────
      const delegations =
        await this.tokenDelegationDB!.findActiveByUserId(userId);
      const estimationResult = await this.executionEstimator!.estimate({
        delegations,
        intentTokenAddress: resolvedFrom!.address,
        intentTokenSymbol: resolvedFrom!.symbol,
        intentAmountRaw: (session.partialParams.amountRaw as string) ?? "0",
        intentAmountHuman: (session.partialParams.amountHuman as string) ?? "0",
      });

      if (!estimationResult.shouldApproveMore) {
        // ── Step C: Sufficient delegation → autonomous execution ──────────────────
        console.log(
          `[Handler] delegation sufficient — pushing auto-sign request to Mini App for userId=${userId}`,
        );
        const { requestId } = await this.signingRequestUseCase!.createRequest({
          userId,
          chatId,
          to: calldata.to,
          value: calldata.value,
          data: calldata.data,
          description: `Autonomous execution for ${session.manifest.name}`,
          autoSign: true,
        });
        await this.safeSend(
          ctx,
          "✅ Check the Aegis mini app to complete the transaction automatically.",
        );
        await this.sendMiniAppButton(ctx as any, requestId, true);
        await this.tryCreateDelegationRequest(
          ctx,
          userId,
          session,
          resolvedFrom,
        );
        return;
      }

      // ── Step D: Insufficient delegation → re-approval prompt ────────────────
      const amountHumanNum = parseFloat(
        (session.partialParams.amountHuman as string) ?? "0",
      );
      const topUp = Math.max(amountHumanNum, 100);
      const rawForReapproval = (
        BigInt(Math.round(topUp)) *
        10n ** BigInt(resolvedFrom!.decimals)
      ).toString();
      const miniAppUrlBase = process.env.MINI_APP_URL ?? "";
      const reapprovalUrl = `${miniAppUrlBase}?reapproval=1&tokenAddress=${encodeURIComponent(resolvedFrom!.address)}&amountRaw=${rawForReapproval}`;
      const keyboard = new InlineKeyboard().webApp(
        "Approve More",
        reapprovalUrl,
      );
      await ctx.reply(estimationResult.displayMessage, {
        reply_markup: keyboard,
      });
      return;
    }

    // ── Fallback: show confirmation message (native or estimator not configured) ──
    await this.safeSend(
      ctx,
      this.buildConfirmationMessage(
        session,
        calldata,
        resolvedFrom,
        resolvedTo,
      ),
    );
    await this.sendMiniAppButton(ctx, undefined);
    await this.tryCreateDelegationRequest(ctx, userId, session, resolvedFrom);
  }

  private async tryCreateDelegationRequest(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    userId: string,
    session: OrchestratorSession,
    resolvedFrom: ITokenRecord | null,
  ): Promise<void> {
    if (
      !this.delegationBuilder ||
      !this.pendingDelegationRepo ||
      !this.userProfileRepo ||
      !resolvedFrom ||
      resolvedFrom.isNative ||
      !session.partialParams.amountHuman
    )
      return;

    try {
      const profile = await this.userProfileRepo.findByUserId(userId);
      if (!profile?.sessionKeyAddress) return;

      const amountRaw = toRaw(
        session.partialParams.amountHuman as string,
        resolvedFrom.decimals,
      );
      const delegationMsg = this.delegationBuilder.buildErc20Spend({
        sessionKeyAddress: profile.sessionKeyAddress,
        target: resolvedFrom.address,
        valueLimit: amountRaw,
        chainId: this.chainId,
      });
      await this.pendingDelegationRepo.create({
        userId,
        zerodevMessage: delegationMsg,
      });

      await ctx.reply(this.buildDelegationPrompt(delegationMsg));
    } catch (err) {
      console.error("[Handler] delegation request error:", err);
    }
  }

  private async sendMiniAppButton(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    requestId?: string,
    isAutoSign?: boolean,
  ): Promise<void> {
    const miniAppUrlBase = process.env.MINI_APP_URL;
    if (!miniAppUrlBase) return;
    let url = miniAppUrlBase;
    if (requestId) {
      url += url.includes("?")
        ? `&requestId=${requestId}`
        : `?requestId=${requestId}`;
    }
    if (isAutoSign) {
      url += url.includes("?") ? `&autoSign=1` : `?autoSign=1`;
    }
    console.log("[sendMiniAppButton] Generated URL:", url);
    const buttonText = isAutoSign
      ? "Execute Automatically"
      : "Open Aegis to Sign";
    const promptText = isAutoSign
      ? "Tap the button below to execute this transaction silently in Aegis."
      : "Tap the button below to review and sign this transaction in Aegis.";
    const keyboard = new InlineKeyboard().webApp(buttonText, url);
    await ctx.reply(promptText, { reply_markup: keyboard });
  }

  // ── Message builders ─────────────────────────────────────────────────────────

  private buildDelegationPrompt(msg: ZerodevMessage): string {
    if (msg.type === ZERODEV_MESSAGE_TYPE.ERC20_SPEND) {
      const expiresDate = new Date(msg.validUntil * 1000)
        .toISOString()
        .split("T")[0];
      return [
        "🔐 *Delegation Request*",
        "",
        "The bot is requesting permission to spend tokens on your behalf.",
        `Token: \`${msg.target}\``,
        `Max amount: ${msg.valueLimit} (raw)`,
        `Expires: ${expiresDate}`,
        "",
        "Open the Aegis app to approve or dismiss this request.",
      ].join("\n");
    }
    return "🔐 Delegation request pending. Open the Aegis app to review.";
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
    lines.push("", "Open the Aegis app to review and sign this transaction.");

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

  // ── Recipient handle resolver (legacy P2P path — unchanged) ─────────────────

  private async resolveRecipientHandle(
    ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
    chatId: number,
    handle: string,
    session: OrchestratorSession,
  ): Promise<boolean> {
    if (!this.telegramHandleResolver || !this.privyAuthService) {
      await ctx.reply(
        "Sorry, peer-to-peer transfers are not configured on this server.",
      );
      this.orchestratorSessions.delete(chatId);
      return false;
    }

    await ctx.reply(`Resolving @${handle}...`);
    let telegramUserId: string;
    try {
      telegramUserId = await this.telegramHandleResolver.resolveHandle(handle);
      console.log(
        `[Handler] resolved @${handle} → telegramUserId=${telegramUserId}`,
      );
      await ctx.reply(`@${handle} → Telegram ID: \`${telegramUserId}\``);
    } catch (err) {
      const isNotFound = err instanceof TelegramHandleNotFoundError;
      const msg = isNotFound
        ? `Sorry, I couldn't find a Telegram user for @${handle}. Double-check the handle and try again.`
        : `Sorry, something went wrong resolving @${handle}. Please try again.`;
      if (!isNotFound)
        console.error(`[Handler] resolveHandle error for @${handle}:`, err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(msg);
      return false;
    }

    await ctx.reply(
      `Finding wallet for Telegram user \`${telegramUserId}\`...`,
    );
    let recipientAddress: string;
    try {
      recipientAddress =
        await this.privyAuthService.getOrCreateWalletByTelegramId(
          telegramUserId,
        );
      console.log(
        `[Handler] resolved telegramUserId=${telegramUserId} → wallet=${recipientAddress}`,
      );
      await ctx.reply(`Recipient wallet: \`${recipientAddress}\``);
    } catch (err) {
      console.error(
        `[Handler] Privy wallet resolution failed for telegramUserId=${telegramUserId}:`,
        err,
      );
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(
        `Sorry, I couldn't set up a wallet for @${handle}. Please try again later.`,
      );
      return false;
    }

    session.partialParams.recipient = recipientAddress;
    session.recipientTelegramUserId = telegramUserId;
    return true;
  }

  // ── Helpers shared by both paths ─────────────────────────────────────────────

  private getMissingRequiredFields(
    manifest: ToolManifest,
    partialParams: Record<string, unknown>,
  ): string[] {
    const inputSchema = manifest.inputSchema as Record<string, unknown>;
    const required = (inputSchema.required as string[] | undefined) ?? [];
    const addressFields = new Set(extractAddressFields(inputSchema));
    return required.filter(
      (field) =>
        !addressFields.has(field) &&
        (partialParams[field] === undefined ||
          partialParams[field] === null ||
          partialParams[field] === ""),
    );
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
}
