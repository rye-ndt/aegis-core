import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import { toRaw } from "../../../../helpers/bigint";
import {
  INTENT_COMMAND,
  parseIntentCommand,
} from "../../../../helpers/enums/intentCommand.enum";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { USER_INTENT_TYPE } from "../../../../helpers/enums/userIntentType.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import {
  type ITokenRecord,
  type ToolManifest,
  DisambiguationRequiredError,
} from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { IDelegationRequestBuilder } from "../../../../use-cases/interface/output/delegation/delegationRequestBuilder.interface";
import type { IPrivyAuthService } from "../../../../use-cases/interface/output/privyAuth.interface";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IResolverEngine } from "../../../../use-cases/interface/output/resolver.interface";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";
import type { ITokenDelegationDB } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IExecutionEstimator } from "../../../../use-cases/interface/output/executionEstimator.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type {
  SignRequest,
  AuthRequest,
  ApproveRequest,
  ApproveSubtype,
} from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { CtxLike, OrchestratorSession } from "./handler.types";
import {
  buildConfirmationMessage,
  buildDelegationPrompt,
  buildDisambiguationPrompt,
  buildFinalSchemaConfirmation,
  populateFinalSchema,
} from "./handler.messages";
import {
  detectStablecoinIntent,
  getMissingRequiredFields,
  pickCandidateByInput,
} from "./handler.utils";

const MINI_APP_URL = process.env.MINI_APP_URL;
const DEFAULT_MAX_COMPILE_TURNS = 10;
const MAX_COMPILE_TURNS = parseInt(
  process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_COMPILE_TURNS),
  10,
);

export class TelegramAssistantHandler {
  private conversations = new Map<number, string>();
  private sessionCache = new Map<number, { userId: string; expiresAtEpoch: number }>();
  private orchestratorSessions = new Map<number, OrchestratorSession>();
  private pendingRecipientNotifications = new Map<string, { telegramUserId: string }>();
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
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
  ) {}

  // ── Bot registration ─────────────────────────────────────────────────────────

  private async sendMiniAppPrompt(
    target: { chatId: number } | { ctx: CtxLike },
    request: AuthRequest | SignRequest | ApproveRequest,
    promptText: string,
    buttonText: string,
    fallbackText?: string,
  ): Promise<void> {
    if (!MINI_APP_URL) {
      if (fallbackText && 'chatId' in target) {
        await this.botRef!.api.sendMessage(target.chatId, fallbackText);
      }
      return;
    }
    if (this.miniAppRequestCache) {
      await this.miniAppRequestCache.store(request);
    }
    const url = `${MINI_APP_URL}?requestId=${request.requestId}`;
    const reply_markup = new InlineKeyboard().webApp(buttonText, url);
    if ('chatId' in target) {
      await this.botRef!.api.sendMessage(target.chatId, promptText, { reply_markup });
    } else {
      await target.ctx.reply(promptText, { reply_markup });
    }
  }

  private async sendWelcomeWithLoginButton(chatId: number): Promise<void> {
    const now = newCurrentUTCEpoch();
    const request: AuthRequest = {
      requestId: newUuid(),
      requestType: 'auth',
      telegramChatId: String(chatId),
      createdAt: now,
      expiresAt: now + 600,
    };
    await this.sendMiniAppPrompt(
      { chatId },
      request,
      'Welcome to Aegis. Sign in to get started.',
      'Open Aegis',
      'Welcome to Aegis.',
    );
  }

  private async sendMiniAppButton(
    ctx: CtxLike,
    userId: string,
    params: {
      to: string;
      value: string;
      data: string;
      description: string;
      autoSign: boolean;
    },
  ): Promise<void> {
    const now = newCurrentUTCEpoch();
    const request: SignRequest = {
      requestId: newUuid(),
      requestType: 'sign',
      userId,
      ...params,
      createdAt: now,
      expiresAt: now + 600,
    };
    const buttonText = params.autoSign ? 'Execute Automatically' : 'Open Aegis to Sign';
    const promptText = params.autoSign
      ? 'Tap below to execute silently.'
      : 'Tap below to review and sign.';
    await this.sendMiniAppPrompt({ ctx }, request, promptText, buttonText);
  }

  private async sendApproveButton(
    chatId: number,
    userId: string,
    subtype: ApproveSubtype,
    promptText: string,
    buttonText: string,
    extra?: { reapproval?: boolean; tokenAddress?: string; amountRaw?: string },
  ): Promise<void> {
    const now = newCurrentUTCEpoch();
    const request: ApproveRequest = {
      requestId: newUuid(),
      requestType: 'approve',
      userId,
      subtype,
      createdAt: now,
      expiresAt: now + 600,
      ...(extra?.reapproval !== undefined ? { reapproval: extra.reapproval } : {}),
      ...(extra?.tokenAddress !== undefined ? { tokenAddress: extra.tokenAddress } : {}),
      ...(extra?.amountRaw !== undefined ? { amountRaw: extra.amountRaw } : {}),
    };
    await this.sendMiniAppPrompt({ chatId }, request, promptText, buttonText);
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

      console.log(`[Handler] message chatId=${chatId} userId=${userId} text="${text}"`);

      try {
        const existing = this.orchestratorSessions.get(chatId);

        if (existing?.stage === "token_disambig") {
          await this.handleDisambiguationReply(ctx, chatId, text, userId, existing);
          return;
        }

        const command = parseIntentCommand(text);

        if (!existing) {
          if (command) {
            await this.startCommandSession(ctx, chatId, userId, command, text);
          } else {
            await this.startLegacySession(ctx, chatId, userId, text);
          }
          return;
        }

        if (existing.stage === "compile") {
          existing.messages.push(text);
          await this.continueCompileLoop(ctx, chatId, userId, existing);
        }
      } catch (err) {
        console.error("[Handler] error handling message:", err);
        await ctx.reply("Sorry, something went wrong. Please try again.");
      }
    });
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
      this.sessionCache.set(ctx.chat.id, { userId, expiresAtEpoch });
      await ctx.reply("Authenticated with Google. You can now use the Onchain Agent.");
    } catch (err) {
      console.error("[Auth] web_app_data loginWithPrivy failed:", err);
      await ctx.reply("Authentication failed. Please try again from the mini app.");
    }
  }

  // ── Phase 1: Session start ───────────────────────────────────────────────────

  private async startCommandSession(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    command: INTENT_COMMAND,
    text: string,
  ): Promise<void> {
    if (!this.intentUseCase) {
      await ctx.reply("Intent service not configured.");
      return;
    }

    const toolResult = await this.intentUseCase.selectTool(
      command as unknown as USER_INTENT_TYPE,
      [text],
    );

    if (!toolResult) {
      await ctx.reply(`No tool is registered for ${command}. Contact the admin.`);
      return;
    }

    console.log(`[Handler] command=${command} → tool=${toolResult.toolId}, compiling schema...`);
    await this.initSessionFromTool(ctx, chatId, userId, text, toolResult);
  }

  private async startLegacySession(
    ctx: CtxLike,
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

    console.log(`[Handler] selected tool=${toolResult.toolId}, compiling schema...`);
    await this.initSessionFromTool(ctx, chatId, userId, text, toolResult);
  }

  private async initSessionFromTool(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    text: string,
    toolResult: { toolId: string; manifest: ToolManifest },
  ): Promise<void> {
    const compileResult = await this.intentUseCase!.compileSchema({
      manifest: toolResult.manifest,
      messages: [text],
      userId,
      partialParams: {},
    });

    if (
      detectStablecoinIntent(text) &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from
    ) {
      console.log(`[Handler] stablecoin intent detected — injecting USDC as fromToken`);
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = { ...compileResult.tokenSymbols, from: "USDC" };
    }

    const session: OrchestratorSession = {
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

    if (compileResult.telegramHandle && !session.recipientTelegramUserId) {
      const resolved = await this.resolveRecipientHandle(ctx, chatId, compileResult.telegramHandle, session);
      if (!resolved) return;
    }

    if (compileResult.missingQuestion) {
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(compileResult.missingQuestion);
      return;
    }

    await this.finishCompileOrResolve(ctx, chatId, userId, session);
  }

  // ── Phase 2: LLM extraction loop ─────────────────────────────────────────────

  private async continueCompileLoop(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
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

    const anyFiatMessage = session.messages.some(detectStablecoinIntent);
    if (
      anyFiatMessage &&
      !compileResult.resolverFields?.[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !session.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] &&
      !compileResult.tokenSymbols?.from &&
      !session.tokenSymbols.from
    ) {
      console.log(`[Handler] stablecoin intent detected (history) — injecting USDC as fromToken`);
      compileResult.resolverFields = {
        ...compileResult.resolverFields,
        [RESOLVER_FIELD.FROM_TOKEN_SYMBOL]: "USDC",
      };
      compileResult.tokenSymbols = { ...compileResult.tokenSymbols, from: "USDC" };
    }

    session.partialParams = { ...session.partialParams, ...compileResult.params };
    session.tokenSymbols = { ...session.tokenSymbols, ...compileResult.tokenSymbols };
    session.resolverFields = { ...session.resolverFields, ...(compileResult.resolverFields ?? {}) };

    if (compileResult.telegramHandle && !session.recipientTelegramUserId) {
      const resolved = await this.resolveRecipientHandle(ctx, chatId, compileResult.telegramHandle, session);
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
    ctx: CtxLike,
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const missing = getMissingRequiredFields(session.manifest, session.partialParams);
    if (missing.length > 0) {
      console.log(`[Handler] post-compile validation: missing fields=${JSON.stringify(missing)}`);
      const question = await this.intentUseCase!.generateMissingParamQuestion(session.manifest, missing);
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(question);
      return;
    }

    const usesDualSchema =
      session.manifest.requiredFields !== undefined &&
      Object.keys(session.manifest.requiredFields).length > 0 &&
      this.resolverEngine !== undefined;

    if (usesDualSchema) {
      await this.runResolutionPhase(ctx, chatId, userId, session);
    } else {
      await this.resolveTokensAndFinish(ctx, chatId, userId, session);
    }
  }

  // ── Phase 3: Dual-schema resolver path ───────────────────────────────────────

  private async runResolutionPhase(
    ctx: CtxLike,
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

      await this.buildAndShowConfirmationFromResolved(ctx, chatId, userId, session);
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
    ctx: CtxLike,
    chatId: number,
    session: OrchestratorSession,
    err: DisambiguationRequiredError,
  ): Promise<void> {
    session.stage = "token_disambig";
    session.disambiguation = {
      resolvedFrom: err.slot === "to" ? (session.resolved?.fromToken ?? null) : null,
      resolvedTo: err.slot === "from" ? (session.resolved?.toToken ?? null) : null,
      awaitingSlot: err.slot,
      fromCandidates: err.slot === "from" ? err.candidates : [],
      toCandidates: err.slot === "to" ? err.candidates : [],
    };
    this.orchestratorSessions.set(chatId, session);
    await ctx.reply(buildDisambiguationPrompt(err.slot, err.symbol, err.candidates));
  }

  // ── Phase 3: Disambiguation reply handler ─────────────────────────────────────

  private async handleDisambiguationReply(
    ctx: CtxLike,
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

    session.disambigTurns += 1;
    if (session.disambigTurns > 10) {
      this.orchestratorSessions.delete(chatId);
      await ctx.reply("Token selection timed out after too many attempts. Please start over.");
      return;
    }

    const candidates = pending.awaitingSlot === "from" ? pending.fromCandidates : pending.toCandidates;
    console.log(
      `[Handler] disambig reply slot=${pending.awaitingSlot} input="${text}" candidates=[${candidates.map((c) => c.symbol).join(", ")}]`,
    );

    const selected = pickCandidateByInput(text, candidates);
    if (!selected) {
      this.orchestratorSessions.delete(chatId);
      await ctx.reply("Disambiguation cancelled. Please repeat your request.");
      return;
    }

    console.log(`[Handler] disambig resolved slot=${pending.awaitingSlot} → ${selected.symbol} (${selected.address})`);

    const usesDualSchema =
      session.manifest.requiredFields !== undefined &&
      Object.keys(session.manifest.requiredFields).length > 0 &&
      this.resolverEngine !== undefined;

    if (pending.awaitingSlot === "from") {
      pending.resolvedFrom = selected;
      if (usesDualSchema) session.resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL] = selected.address;

      if (pending.toCandidates.length > 1) {
        pending.awaitingSlot = "to";
        this.orchestratorSessions.set(chatId, session);
        await ctx.reply(buildDisambiguationPrompt("to", session.tokenSymbols.to ?? "", pending.toCandidates));
        return;
      }
      pending.resolvedTo = pending.toCandidates[0] ?? null;
    } else {
      pending.resolvedTo = selected;
      if (usesDualSchema) session.resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL] = selected.address;
    }

    session.disambiguation = undefined;
    session.stage = "compile";

    if (usesDualSchema) {
      await this.runResolutionPhase(ctx, chatId, userId, session);
    } else {
      await this.buildAndShowConfirmation(ctx, chatId, userId, session, pending.resolvedFrom, pending.resolvedTo);
    }
  }

  // ── Phase 3: Legacy token-resolution path ─────────────────────────────────────

  private async resolveTokensAndFinish(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const chainId = this.chainId;
    let fromCandidates: ITokenRecord[] = [];
    let toCandidates: ITokenRecord[] = [];

    if (session.tokenSymbols.from) {
      fromCandidates = await this.intentUseCase!.searchTokens(session.tokenSymbols.from, chainId);
      console.log(`[Handler] fromToken "${session.tokenSymbols.from}" candidates: ${fromCandidates.length}`);
      if (fromCandidates.length === 0) {
        await ctx.reply(`Token not found: ${session.tokenSymbols.from}. Make sure it is supported on this chain.`);
        this.orchestratorSessions.delete(chatId);
        return;
      }
    }

    if (session.tokenSymbols.to) {
      toCandidates = await this.intentUseCase!.searchTokens(session.tokenSymbols.to, chainId);
      console.log(`[Handler] toToken "${session.tokenSymbols.to}" candidates: ${toCandidates.length}`);
      if (toCandidates.length === 0) {
        await ctx.reply(`Token not found: ${session.tokenSymbols.to}. Make sure it is supported on this chain.`);
        this.orchestratorSessions.delete(chatId);
        return;
      }
    }

    const resolvedFrom = fromCandidates.length === 1 ? fromCandidates[0]! : null;
    const resolvedTo = toCandidates.length === 1 ? toCandidates[0]! : null;

    if (fromCandidates.length > 1) {
      session.stage = "token_disambig";
      session.disambiguation = { resolvedFrom: null, resolvedTo: null, awaitingSlot: "from", fromCandidates, toCandidates };
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(buildDisambiguationPrompt("from", session.tokenSymbols.from!, fromCandidates));
      return;
    }

    if (toCandidates.length > 1) {
      session.stage = "token_disambig";
      session.disambiguation = { resolvedFrom, resolvedTo: null, awaitingSlot: "to", fromCandidates, toCandidates };
      this.orchestratorSessions.set(chatId, session);
      await ctx.reply(buildDisambiguationPrompt("to", session.tokenSymbols.to!, toCandidates));
      return;
    }

    await this.buildAndShowConfirmation(ctx, chatId, userId, session, resolvedFrom, resolvedTo);
  }

  // ── Phase 4: Confirmation (dual-schema path) ──────────────────────────────────

  private async buildAndShowConfirmationFromResolved(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    session: OrchestratorSession,
  ): Promise<void> {
    const { resolved } = session;
    if (!resolved) {
      await ctx.reply("Internal error: resolution payload missing. Please try again.");
      return;
    }

    if (resolved.rawAmount) session.partialParams.amountRaw = resolved.rawAmount;
    if (resolved.recipientAddress) session.partialParams.recipient = resolved.recipientAddress;
    if (resolved.senderAddress) session.partialParams.userAddress = resolved.senderAddress;

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
      await ctx.reply(`Could not build transaction: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (session.recipientTelegramUserId) {
      this.pendingRecipientNotifications.set(userId, { telegramUserId: session.recipientTelegramUserId });
    }
    this.orchestratorSessions.delete(chatId);

    const fromToken = resolved.fromToken;
    if (fromToken && !fromToken.isNative && this.tokenDelegationDB && this.executionEstimator) {
      const handled = await this.runDelegationCheck(ctx, chatId, userId, calldata, fromToken, session);
      if (handled) return;
    }

    if (session.manifest.finalSchema) {
      const filled = populateFinalSchema(session.manifest.finalSchema, resolved, session.partialParams);
      await this.safeSend(ctx, buildFinalSchemaConfirmation(session, filled, calldata));
    } else {
      await this.safeSend(ctx, buildConfirmationMessage(session, calldata, resolved.fromToken, resolved.toToken));
    }
    await this.sendMiniAppButton(ctx, userId, {
      to: calldata.to,
      value: calldata.value,
      data: calldata.data,
      description: session.manifest.name,
      autoSign: false,
    });
    await this.tryCreateDelegationRequest(ctx, userId, session, fromToken ?? null);
  }

  // ── Phase 4: Confirmation (legacy path) ──────────────────────────────────────

  private async buildAndShowConfirmation(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    session: OrchestratorSession,
    resolvedFrom: ITokenRecord | null,
    resolvedTo: ITokenRecord | null,
  ): Promise<void> {
    let calldata: { to: string; data: string; value: string };
    try {
      calldata = await this.intentUseCase!.buildRequestBody({
        manifest: session.manifest,
        params: session.partialParams,
        resolvedFrom,
        resolvedTo,
        userId,
        amountHuman: session.partialParams.amountHuman as string | undefined,
      });
    } catch (err) {
      console.error("[Handler] buildRequestBody failed:", err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(`Could not build transaction: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (session.recipientTelegramUserId) {
      this.pendingRecipientNotifications.set(userId, { telegramUserId: session.recipientTelegramUserId });
    }
    this.orchestratorSessions.delete(chatId);

    if (resolvedFrom && !resolvedFrom.isNative && this.tokenDelegationDB && this.executionEstimator) {
      const handled = await this.runDelegationCheck(ctx, chatId, userId, calldata, resolvedFrom, session);
      if (handled) return;
    }

    await this.safeSend(ctx, buildConfirmationMessage(session, calldata, resolvedFrom, resolvedTo));
    await this.sendMiniAppButton(ctx, userId, {
      to: calldata.to,
      value: calldata.value,
      data: calldata.data,
      description: session.manifest.name,
      autoSign: false,
    });
    await this.tryCreateDelegationRequest(ctx, userId, session, resolvedFrom);
  }

  private async runDelegationCheck(
    ctx: CtxLike,
    chatId: number,
    userId: string,
    calldata: { to: string; data: string; value: string },
    fromToken: ITokenRecord,
    session: OrchestratorSession,
  ): Promise<boolean> {
    const delegations = await this.tokenDelegationDB!.findActiveByUserId(userId);
    const estimationResult = await this.executionEstimator!.estimate({
      delegations,
      intentTokenAddress: fromToken.address,
      intentTokenSymbol: fromToken.symbol,
      intentAmountRaw: (session.partialParams.amountRaw as string) ?? "0",
      intentAmountHuman: (session.partialParams.amountHuman as string) ?? "0",
    });

    if (!estimationResult.shouldApproveMore) {
      console.log(`[Handler] delegation sufficient — pushing auto-sign request to Mini App for userId=${userId}`);
      await this.safeSend(ctx, "✅ Check the Aegis mini app to complete the transaction automatically.");
      await this.sendMiniAppButton(ctx, userId, {
        to: calldata.to,
        value: calldata.value,
        data: calldata.data,
        description: `Autonomous execution for ${session.manifest.name}`,
        autoSign: true,
      });
      await this.tryCreateDelegationRequest(ctx, userId, session, fromToken);
      return true;
    }

    const amountHumanNum = parseFloat((session.partialParams.amountHuman as string) ?? "0");
    const topUp = Math.max(amountHumanNum, 100);
    const rawForReapproval = (BigInt(Math.round(topUp)) * 10n ** BigInt(fromToken.decimals)).toString();
    await this.sendApproveButton(
      chatId,
      userId,
      "aegis_guard",
      estimationResult.displayMessage,
      "Approve More",
      {
        reapproval: true,
        tokenAddress: fromToken.address,
        amountRaw: rawForReapproval,
      },
    );
    return true;
  }

  // ── Shared helpers ────────────────────────────────────────────────────────────

  private async tryCreateDelegationRequest(
    ctx: CtxLike,
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

      const amountRaw = toRaw(session.partialParams.amountHuman as string, resolvedFrom.decimals);
      const delegationMsg = this.delegationBuilder.buildErc20Spend({
        sessionKeyAddress: profile.sessionKeyAddress,
        target: resolvedFrom.address,
        valueLimit: amountRaw,
        chainId: this.chainId,
      });
      await this.pendingDelegationRepo.create({ userId, zerodevMessage: delegationMsg });
      await ctx.reply(buildDelegationPrompt(delegationMsg));
    } catch (err) {
      console.error("[Handler] delegation request error:", err);
    }
  }

  private async resolveRecipientHandle(
    ctx: CtxLike,
    chatId: number,
    handle: string,
    session: OrchestratorSession,
  ): Promise<boolean> {
    if (!this.telegramHandleResolver || !this.privyAuthService) {
      await ctx.reply("Sorry, peer-to-peer transfers are not configured on this server.");
      this.orchestratorSessions.delete(chatId);
      return false;
    }

    await ctx.reply(`Resolving @${handle}...`);
    let telegramUserId: string;
    try {
      telegramUserId = await this.telegramHandleResolver.resolveHandle(handle);
      console.log(`[Handler] resolved @${handle} → telegramUserId=${telegramUserId}`);
      await ctx.reply(`@${handle} → Telegram ID: \`${telegramUserId}\``);
    } catch (err) {
      const isNotFound = err instanceof TelegramHandleNotFoundError;
      const msg = isNotFound
        ? `Sorry, I couldn't find a Telegram user for @${handle}. Double-check the handle and try again.`
        : `Sorry, something went wrong resolving @${handle}. Please try again.`;
      if (!isNotFound) console.error(`[Handler] resolveHandle error for @${handle}:`, err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(msg);
      return false;
    }

    await ctx.reply(`Finding wallet for Telegram user \`${telegramUserId}\`...`);
    let recipientAddress: string;
    try {
      recipientAddress = await this.privyAuthService.getOrCreateWalletByTelegramId(telegramUserId);
      console.log(`[Handler] resolved telegramUserId=${telegramUserId} → wallet=${recipientAddress}`);
      await ctx.reply(`Recipient wallet: \`${recipientAddress}\``);
    } catch (err) {
      console.error(`[Handler] Privy wallet resolution failed for telegramUserId=${telegramUserId}:`, err);
      this.orchestratorSessions.delete(chatId);
      await ctx.reply(`Sorry, I couldn't set up a wallet for @${handle}. Please try again later.`);
      return false;
    }

    session.partialParams.recipient = recipientAddress;
    session.recipientTelegramUserId = telegramUserId;
    return true;
  }

  private async handleFallbackChat(
    ctx: CtxLike,
    chatId: number,
    text: string,
    userId: string,
  ): Promise<void> {
    const conversationId = this.conversations.get(chatId);
    console.log(`[Handler] fallback chat userId=${userId} conversationId=${conversationId ?? "new"}`);
    const response = await this.assistantUseCase.chat({ userId, conversationId, message: text });
    this.conversations.set(chatId, response.conversationId);
    console.log(`[Handler] fallback chat done toolsUsed=[${response.toolsUsed.join(", ")}]`);
    await this.safeSend(ctx, response.reply);
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

  private async safeSend(ctx: CtxLike, text: string): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text);
    }
  }
}
