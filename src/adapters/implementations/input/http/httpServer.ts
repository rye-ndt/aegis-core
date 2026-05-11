import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { CHAIN_CONFIG, getNativeTokenInfo, getUsdcAddress } from "../../../../helpers/chainConfig";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import type { ISessionDelegationUseCase } from "../../../../use-cases/interface/input/sessionDelegation.interface";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { IUserPreferencesDB } from "../../../../use-cases/interface/output/repository/userPreference.repo";
import type { ITokenDelegationDB, NewTokenDelegation } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { IUserDB } from "../../../../use-cases/interface/output/repository/user.repo";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { ITelegramNotifier } from "../../../../use-cases/interface/output/telegramNotifier.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { IPendingIntentStore } from "../../../../use-cases/interface/output/cache/pendingIntent.cache";
import type { ICapabilityDispatcher } from "../../../../use-cases/interface/input/capabilityDispatcher.interface";
import type { IYieldOptimizerUseCase } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import type { ITransferHistoryUseCase } from "../../../../use-cases/interface/input/transferHistory.interface";
import type { IPredictionMarketBetUseCase } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetUseCase";
import type { IPolymarketAdapter } from "../../../../use-cases/interface/predictionMarket/IPolymarketAdapter";
import type { IPredictionMarketReceiptBroadcaster } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketReceiptBroadcaster";
import type { IRelayClient } from "../../../../use-cases/interface/output/relay.interface";
import type { IPredictionMarketRepository } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketRepository";
import { PREDICTION_MARKETS_ENV } from "../../../../helpers/env/predictionMarketEnv";
import {
  BET_TRANSITION_STATUSES,
  BET_TERMINAL_STATUSES,
  IllegalBetTransitionError,
  SETUP_STEPS,
} from "../../../../use-cases/interface/predictionMarket/IPredictionMarketBetRepository";
import type { SubgraphPrincipalProvider } from "../../output/yield/subgraphPrincipalProvider";
import { isRateLimitedError } from "../../../../helpers/errors/rateLimitedError";
import { isUnsupportedChainError } from "../../../../helpers/errors/unsupportedChainError";
import { LOYALTY_ENV } from "../../../../helpers/env/loyaltyEnv";
import { DELEGATION_ENV, STABLE_SYMBOLS } from "../../../../helpers/env/delegationEnv";
import { toRaw } from "../../../../helpers/bigint";
import type {
  MiniAppResponse,
  AuthResponse,
  SignResponse,
  ApproveResponse,
  ApproveRequest,
  DelegationRecord as MiniAppDelegationRecord,
} from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { DelegationRecord as SessionDelegationRecord } from "../../../../use-cases/interface/output/cache/sessionDelegation.cache";
import { SESSION_KEY_STATUSES } from "../../../../helpers/enums/sessionKeyStatus.enum";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import { metricsRegistry } from "../../../../helpers/observability/metricsRegistry";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("httpServer");
const METRICS_TOKEN = process.env.METRICS_TOKEN;
const ADMIN_PRIVY_DIDS = new Set(
  (process.env.ADMIN_PRIVY_DIDS ?? "").split(",").map(s => s.trim()).filter(Boolean),
);

const MiniAppResponseSchema = z.discriminatedUnion('requestType', [
  z.object({
    requestId: z.string().min(1),
    requestType: z.literal('auth'),
    privyToken: z.string().min(1),
    telegramChatId: z.string().min(1),
  }),
  z.object({
    requestId: z.string().min(1),
    requestType: z.literal('sign'),
    privyToken: z.string().min(1),
    txHash: z.string().optional(),
    rejected: z.boolean().optional(),
    errorCode: z.string().max(64).optional(),
    errorMessage: z.string().max(512).optional(),
    errorRaw: z.string().max(1024).optional(),
  }),
  z.object({
    requestId: z.string().min(1),
    requestType: z.literal('approve'),
    privyToken: z.string().min(1),
    subtype: z.enum(['session_key', 'aegis_guard']),
    delegationRecord: z.object({
      publicKey: z.string().min(1),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      smartAccountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      signerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      permissions: z.array(z.unknown()),
      grantedAt: z.number().int().positive(),
    }).optional(),
    aegisGrant: z.object({
      sessionKeyAddress: z.string().min(1),
      smartAccountAddress: z.string().min(1),
      tokens: z.array(z.object({
        address: z.string().min(1),
        limit: z.string().min(1),
        validUntil: z.number().int().positive(),
      })),
    }).optional(),
    rejected: z.boolean().optional(),
  }),
]);

export class HttpApiServer {
  private server: http.Server;
  private readonly reqLogIds = new WeakMap<http.IncomingMessage, string>();
  private readonly resLogIds = new WeakMap<http.ServerResponse, string>();
  private readonly startedAtEpoch = newCurrentUTCEpoch();

  constructor(
    private readonly authUseCase: IAuthUseCase,
    private readonly port: number,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly portfolioUseCase?: IPortfolioUseCase,
    private readonly sessionDelegationUseCase?: ISessionDelegationUseCase,
    private readonly pendingDelegationRepo?: IPendingDelegationDB,
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
    private readonly signingRequestUseCase?: ISigningRequestUseCase,
    private readonly userProfileCache?: IUserProfileCache,
    private readonly userPreferencesRepo?: IUserPreferencesDB,
    private readonly tokenDelegationRepo?: ITokenDelegationDB,
    private readonly userProfileDB?: IUserProfileDB,
    private readonly telegramSessionRepo?: ITelegramSessionDB,
    private readonly telegramNotifier?: ITelegramNotifier,
    private readonly yieldOptimizerUseCase?: IYieldOptimizerUseCase,
    private readonly loyaltyUseCase?: ILoyaltyUseCase,
    private readonly userDB?: IUserDB,
    private readonly transferHistoryUseCase?: ITransferHistoryUseCase,
    /** Optional — exposes subgraph health for /health response. */
    private readonly subgraphPrincipalProvider?: SubgraphPrincipalProvider,
    /** Optional — keyed by approval requestId; populated by /send and /swap when guard fails. */
    private readonly pendingIntentStore?: IPendingIntentStore,
    /**
     * Lazy accessor for the dispatcher. The HTTP-only replica (`httpCli`) has
     * no dispatcher and skips post-approval resume; the telegram replica
     * builds the dispatcher after the http server starts so we can't take it
     * directly in the constructor.
     */
    private readonly getCapabilityDispatcher?: () => Promise<ICapabilityDispatcher | undefined>,
    /** Stage 4: prediction-market bet orchestration. Optional — endpoints 503 when absent. */
    private readonly predictionMarketBetUseCase?: IPredictionMarketBetUseCase,
    /** Stage 4: Polymarket CLOB adapter (orderbook + signed-order forwarding). */
    private readonly polymarketAdapter?: IPolymarketAdapter,
    /** Stage 4: pushes receipt cards to chat after terminal bet/close events. */
    private readonly predictionMarketReceiptBroadcaster?: IPredictionMarketReceiptBroadcaster,
    /** Stage 4: Relay status passthrough for the FE bridge poller. */
    private readonly relayClient?: IRelayClient,
    /** Phase 4 (Part 5): admin route reads `getShadowAgreement` from here. */
    private readonly predictionMarketRepo?: IPredictionMarketRepository,
  ) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error({ err }, "unhandled request error");
        this.sendJson(res, 500, { error: "Internal server error" });
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const base = `http://localhost`;
    const url = new URL(req.url ?? "/", base);
    const method = req.method?.toUpperCase();

    const reqId = newUuid().slice(0, 8);
    this.reqLogIds.set(req, reqId);
    this.resLogIds.set(res, reqId);
    log.info({ reqId, method, path: `${url.pathname}${url.search}` }, "request received");

    // CORS — allow the mini app dev server and any deployed origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const route = this.matchRoute(method ?? "", url.pathname);
    if (route) return route(req, res, url);

    res.writeHead(404);
    res.end("Not found");
  }

  private matchRoute(
    method: string,
    pathname: string,
  ): ((req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>) | null {
    const exactKey = `${method} ${pathname}`;
    const exact = this.exactRoutes[exactKey];
    if (exact) return exact;

    for (const [pattern, handler] of this.paramRoutes) {
      if (pattern.method !== method) continue;
      const m = pathname.match(pattern.regex);
      if (m) return (req, res, url) => handler(req, res, url, m[1]!);
    }
    return null;
  }

  private get exactRoutes(): Record<string, (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>> {
    return {
      "POST /auth/privy":               (req, res) => this.handlePrivyLogin(req, res),
      "GET /user/profile":              (req, res) => this.handleGetUserProfile(req, res),
      "GET /portfolio":                 (req, res) => this.handleGetPortfolio(req, res),
      "GET /transfers":                 (req, res, url) => this.handleGetTransfers(req, res, url),
      "GET /tokens":                    (req, res, url) => this.handleGetTokens(req, res, url),
      "GET /permissions":               (req, res, url) => this.handleGetPermissions(req, res, url),
      "GET /delegation/pending":        (req, res) => this.handleGetPendingDelegation(req, res),
      "POST /response":                 (req, res) => this.handlePostResponse(req, res),
      "GET /preference":                (req, res) => this.handleGetPreference(req, res),
      "POST /preference":               (req, res) => this.handlePostPreference(req, res),
      "GET /delegation/approval-params": (req, res, url) => this.handleGetDelegationApprovalParams(req, res, url),
      "POST /delegation/grant":         (req, res) => this.handlePostDelegationGrant(req, res),
      "GET /delegation/grant":          (req, res) => this.handleGetDelegationGrant(req, res),
      "GET /delegation/spending-limits": (req, res, url) => this.handleGetDelegationSpendingLimits(req, res, url),
      "POST /delegation/revoke":        (req, res) => this.handlePostDelegationRevoke(req, res),
      "GET /yield/positions":           (req, res) => this.handleGetYieldPositions(req, res),
      "GET /loyalty/balance":           (req, res) => this.handleGetLoyaltyBalance(req, res),
      "GET /loyalty/history":           (req, res, url) => this.handleGetLoyaltyHistory(req, res, url),
      "GET /loyalty/leaderboard":       (req, res, url) => this.handleGetLoyaltyLeaderboard(req, res, url),
      "GET /metrics":                   (req, res) => this.handleGetMetrics(req, res),
      "POST /health":                   (req, res) => this.handleHealth(req, res),
      "POST /predictionMarket/setup/init":  (req, res) => this.handlePmSetupInit(req, res),
      "POST /predictionMarket/setup/creds": (req, res) => this.handlePmSetupCreds(req, res),
      "GET /predictionMarket/state":        (req, res) => this.handlePmState(req, res),
      "GET /predictionMarket/intent/active":(req, res) => this.handlePmActiveIntent(req, res),
      "POST /predictionMarket/order/place": (req, res) => this.handlePmPlaceOrder(req, res),
      // Sell-side closes use the same place-order body shape (`order.side: "SELL"`).
      // We expose the alias so the construction-doc URL surface is honest.
      "POST /predictionMarket/order/sell":  (req, res) => this.handlePmPlaceOrder(req, res),
      "GET /predictionMarket/positions":    (req, res) => this.handlePmListPositions(req, res),
      "GET /admin/prediction-markets/shadow-agreement": (req, res, url) => this.handleShadowAgreement(req, res, url),
    };
  }

  private async handleShadowAgreement(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const reqId = this.reqLogIds.get(req) ?? "?";
    // Bearer-token gate. Empty env disables the endpoint entirely (404) so
    // a misconfigured deploy can't accidentally leak shadow metrics.
    const expectedToken = PREDICTION_MARKETS_ENV.adminHttpToken;
    if (!expectedToken) {
      log.debug({ reqId }, "shadow-agreement endpoint disabled (no admin token)");
      return this.sendJson(res, 404, { error: "Not found" });
    }
    const authHeader = req.headers["authorization"];
    const provided = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!provided || provided !== expectedToken) {
      log.warn({ reqId, hasHeader: !!authHeader }, "shadow-agreement unauthorized");
      return this.sendJson(res, 401, { error: "Unauthorized" });
    }
    if (!this.predictionMarketRepo) {
      return this.sendJson(res, 503, { error: "Prediction market repo not available" });
    }
    const windowDaysRaw = url.searchParams.get("windowDays");
    const windowDays = windowDaysRaw ? Math.max(1, Math.min(30, parseInt(windowDaysRaw, 10))) : 7;
    if (!Number.isFinite(windowDays)) {
      return this.sendJson(res, 400, { error: "windowDays must be an integer 1..30" });
    }
    try {
      const report = await this.predictionMarketRepo.getShadowAgreement(windowDays * 86_400);
      log.info({ reqId, windowDays }, "shadow-agreement served");
      return this.sendJson(res, 200, report);
    } catch (err) {
      log.error({ err, reqId }, "shadow-agreement query failed");
      return this.sendJson(res, 500, { error: "Internal server error" });
    }
  }

  private get paramRoutes(): Array<[
    { method: string; regex: RegExp },
    (req: http.IncomingMessage, res: http.ServerResponse, url: URL, param: string) => Promise<void>
  ]> {
    return [
      [{ method: "POST",   regex: /^\/delegation\/([^/]+)\/signed$/ }, (req, res, _u, id) => this.handlePostDelegationSigned(req, res, id)],
      [{ method: "GET",    regex: /^\/request\/([^/]+)$/ },           (req, res, url, requestId) => this.handleGetMiniAppRequest(req, res, url, requestId)],
      [{ method: "POST",   regex: /^\/predictionMarket\/setup\/([a-z_]+)$/ }, (req, res, _u, step) => this.handlePmSetupStep(req, res, step)],
      [{ method: "GET",    regex: /^\/predictionMarket\/intent\/([0-9a-f-]+)$/ }, (req, res, _u, id) => this.handlePmGetIntent(req, res, id)],
      [{ method: "POST",   regex: /^\/predictionMarket\/intent\/([0-9a-f-]+)\/cancel$/ }, (req, res, _u, id) => this.handlePmCancelIntent(req, res, id)],
      [{ method: "GET",    regex: /^\/predictionMarket\/bet\/([0-9a-f-]+)$/ }, (req, res, _u, id) => this.handlePmGetBet(req, res, id)],
      [{ method: "POST",   regex: /^\/predictionMarket\/bet\/([0-9a-f-]+)\/transition$/ }, (req, res, _u, id) => this.handlePmTransitionBet(req, res, id)],
      [{ method: "POST",   regex: /^\/predictionMarket\/bet\/([0-9a-f-]+)\/finalize$/ }, (req, res, _u, id) => this.handlePmFinalizeBet(req, res, id)],
      [{ method: "GET",    regex: /^\/predictionMarket\/bet\/([0-9a-f-]+)\/bridge-status$/ }, (req, res, _u, id) => this.handlePmBridgeStatus(req, res, id)],
      [{ method: "POST",   regex: /^\/predictionMarket\/bet\/([0-9a-f-]+)\/drift-detected$/ }, (req, res, _u, id) => this.handlePmDriftDetected(req, res, id)],
      [{ method: "POST",   regex: /^\/predictionMarket\/bet\/([0-9a-f-]+)\/refund$/ }, (req, res, _u, id) => this.handlePmRecordRefund(req, res, id)],
      [{ method: "GET",    regex: /^\/predictionMarket\/orderbook\/([^/]+)$/ }, (req, res, _u, id) => this.handlePmOrderbook(req, res, id)],
      [{ method: "POST",   regex: /^\/predictionMarket\/order\/cancel\/([^/]+)$/ }, (req, res, _u, id) => this.handlePmCancelOrder(req, res, id)],
    ];
  }

  private async handlePrivyLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqId = this.reqLogIds.get(req) ?? "?";
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ reqId, path: "POST /auth/privy", err: msg }, "invalid-json-body");
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = z.object({
      privyToken: z.string().min(1),
      telegramChatId: z.string().regex(/^\d+$/).optional(),
    }).safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: "privyToken is required", details: parsed.error.issues });
    }

    try {
      const { userId, expiresAtEpoch } = await this.authUseCase.loginWithPrivy({
        privyToken: parsed.data.privyToken,
        telegramChatId: parsed.data.telegramChatId,
      });
      return this.sendJson(res, 200, { userId, expiresAtEpoch });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === "PRIVY_NOT_CONFIGURED" || err.message.toLowerCase().includes("invalid"))
      ) {
        return this.sendJson(res, 401, { error: "Invalid or expired Privy token" });
      }
      throw err;
    }
  }

  private async handleGetUserProfile(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.userProfileCache) return this.sendJson(res, 503, { error: "Profile cache not available" });

    const profile = await this.userProfileCache.get(userId);
    if (!profile) return this.sendJson(res, 404, { error: "Profile not found or expired" });
    return this.sendJson(res, 200, profile);
  }

  private async handleGetPortfolio(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.portfolioUseCase) return this.sendJson(res, 503, { error: "Portfolio service not available" });

    const result = await this.portfolioUseCase.getPortfolio(userId);
    if (!result) return this.sendJson(res, 404, { error: "No Smart Contract Account found" });
    return this.sendJson(res, 200, result);
  }

  private async handleGetTransfers(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.transferHistoryUseCase) {
      return this.sendJson(res, 503, { error: "Transfer history service not available" });
    }

    const QuerySchema = z.object({
      fromEpoch: z.coerce.number().int().nonnegative().optional(),
      toEpoch: z.coerce.number().int().nonnegative().optional(),
      direction: z.enum(["in", "out", "self"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(2048).optional(),
    });
    const parsed = QuerySchema.safeParse({
      fromEpoch: url.searchParams.get("fromEpoch") ?? undefined,
      toEpoch: url.searchParams.get("toEpoch") ?? undefined,
      direction: url.searchParams.get("direction") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: "Invalid query", details: parsed.error.issues });
    }

    const start = Date.now();
    try {
      const page = await this.transferHistoryUseCase.getHistory({
        userId,
        fromEpoch: parsed.data.fromEpoch,
        toEpoch: parsed.data.toEpoch,
        direction: parsed.data.direction,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      });
      res.setHeader("Cache-Control", "private, max-age=30");
      log.info(
        { userId, route: "GET /transfers", durationMs: Date.now() - start, count: page.items.length },
        "request-served",
      );
      return this.sendJson(res, 200, page);
    } catch (err) {
      if (isRateLimitedError(err)) {
        log.warn({ userId, route: "GET /transfers", retryAfterSec: err.retryAfterSec }, "rate-limited");
        res.setHeader("Retry-After", String(err.retryAfterSec));
        return this.sendJson(res, 429, { error: "rate-limited", retryAfterSec: err.retryAfterSec });
      }
      if (isUnsupportedChainError(err)) {
        log.warn({ userId, route: "GET /transfers", chainId: err.chainId }, "unsupported-chain");
        return this.sendJson(res, 400, { error: "unsupported-chain", chainId: err.chainId });
      }
      log.error({ err, userId, route: "GET /transfers" }, "request-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handleGetTokens(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.portfolioUseCase) {
      return this.sendJson(res, 503, { error: "Token registry not available" });
    }
    const chainIdStr = url.searchParams.get("chainId");
    const chainId = chainIdStr ? parseInt(chainIdStr, 10) : CHAIN_CONFIG.chainId;
    const tokens = await this.portfolioUseCase.listTokens(chainId);
    return this.sendJson(res, 200, { tokens });
  }

  private async handleGetPermissions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: 'unauthorized' });

    if (!this.sessionDelegationUseCase) {
      return this.sendJson(res, 503, { error: 'Session delegation store not available' });
    }

    const param = url.searchParams.get('public_key');
    if (!param) {
      return this.sendJson(res, 400, { error: 'public_key query parameter is required' });
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(param)) {
      return this.sendJson(res, 400, {
        error: 'public_key must be a valid Ethereum address (0x followed by 40 hex characters)',
      });
    }

    const profile = await this.userProfileDB?.findByUserId(userId);
    if (!profile?.smartAccountAddress || profile.smartAccountAddress.toLowerCase() !== param.toLowerCase()) {
      log.warn({ userId, route: "GET /permissions" }, "permissions-forbidden");
      return this.sendJson(res, 403, { error: 'forbidden' });
    }

    const record = await this.sessionDelegationUseCase.findByAddress(param);
    if (!record) {
      return this.sendJson(res, 404, { error: 'No delegation record found for this address' });
    }

    return this.sendJson(res, 200, record);
  }

  private async handleGetPendingDelegation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: 'Unauthorized' });
    if (!this.pendingDelegationRepo) {
      return this.sendJson(res, 503, { error: 'Delegation service not available' });
    }

    const record = await this.pendingDelegationRepo.findLatestByUserId(userId);
    if (!record || record.status !== 'pending') {
      return this.sendJson(res, 404, { error: 'No pending delegation' });
    }

    return this.sendJson(res, 200, {
      id: record.id,
      zerodevMessage: record.zerodevMessage,
    });
  }

  private async handlePostDelegationSigned(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: 'Unauthorized' });
    if (!this.pendingDelegationRepo) {
      return this.sendJson(res, 503, { error: 'Delegation service not available' });
    }
    if (!id) return this.sendJson(res, 400, { error: 'Delegation ID required' });

    const reqId = this.reqLogIds.get(req) ?? "?";
    try {
      await this.pendingDelegationRepo.markSigned(id);
      return this.sendJson(res, 200, { id, signed: true });
    } catch (err) {
      log.error({ err, reqId, path: "POST /delegation/pending/:id/signed" }, "request-handler-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  // ── GET /request/:requestId (no auth) ────────────────────────────────────────

  private async handleGetMiniAppRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    if (!this.miniAppRequestCache) {
      return this.sendJson(res, 503, { error: 'Mini app request service not available' });
    }

    // `?after=<prevId>` means "give me the next queued SignRequest for the
    // authenticated user, regardless of the :id in the path". Used by the
    // mini-app's step-chaining flow for multi-step swaps — the FE doesn't
    // know the next request's id ahead of time.
    const after = url.searchParams.get('after');
    if (after) {
      const userId = await this.extractUserId(req);
      if (!userId) return this.sendJson(res, 401, { error: 'Unauthorized' });
      const next = await this.miniAppRequestCache.findNextPendingSignForUser(userId);
      if (!next) return this.sendJson(res, 404, { error: 'No next request' });
      // `after` means "give me the request *after* this one". If the queue
      // still has the same id (cleanup race), do NOT return it — that would
      // make the FE treat it as a follow-up step and loop on it.
      if (next.requestId === after) return this.sendJson(res, 404, { error: 'No next request' });
      if (next.expiresAt <= newCurrentUTCEpoch()) {
        return this.sendJson(res, 410, { error: 'Expired' });
      }
      return this.sendJson(res, 200, next);
    }

    const request = await this.miniAppRequestCache.retrieve(requestId);
    if (!request) return this.sendJson(res, 404, { error: 'Not found' });

    const now = newCurrentUTCEpoch();
    if (request.expiresAt <= now) return this.sendJson(res, 410, { error: 'Expired' });

    if (request.requestType !== 'auth') {
      const userId = await this.extractUserId(req);
      if (!userId) return this.sendJson(res, 401, { error: 'unauthorized' });
      const ownerUserId = (request as { userId: string }).userId;
      if (ownerUserId !== userId) {
        log.warn({ requestId, callerUserId: userId, ownerUserId }, "request-ownership-mismatch");
        return this.sendJson(res, 403, { error: 'forbidden' });
      }
    }

    return this.sendJson(res, 200, request);
  }

  // ── POST /response (Privy auth) ───────────────────────────────────────────────

  private async handlePostResponse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.miniAppRequestCache) {
      return this.sendJson(res, 503, { error: 'Mini app request service not available' });
    }

    const reqId = this.reqLogIds.get(req) ?? "?";
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ reqId, path: "POST /response", err: msg }, "invalid-json-body");
      return this.sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const parsed = MiniAppResponseSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: 'Invalid body', details: parsed.error.issues });
    }

    const response = parsed.data as MiniAppResponse;

    const request = await this.miniAppRequestCache.retrieve(response.requestId);
    if (!request) return this.sendJson(res, 404, { error: 'Not found' });

    // Auth is the account-creating path: it must accept a valid Privy token
    // even when no user row exists yet. loginWithPrivy will create or link one.
    if (response.requestType === 'auth') {
      return this.handleAuthMiniAppResponse(response as AuthResponse, res);
    }

    // Non-auth requests require an existing user tied to the Privy DID.
    const userId = await this.authUseCase.resolveUserId(response.privyToken);
    if (!userId) return this.sendJson(res, 401, { error: 'Unauthorized' });

    const requestWithUser = request as { userId?: string };
    if (requestWithUser.userId !== userId) {
      return this.sendJson(res, 403, { error: 'Forbidden' });
    }

    if (response.requestType === 'sign') {
      await this.handleSignMiniAppResponse(response as SignResponse, userId, res);
    } else if (response.requestType === 'approve') {
      await this.handleApproveMiniAppResponse(response as ApproveResponse, userId, res);
    } else {
      return this.sendJson(res, 400, { error: 'Unknown requestType' });
    }
  }

  private async handleAuthMiniAppResponse(
    body: AuthResponse,
    res: http.ServerResponse,
  ): Promise<void> {
    let userId: string;
    try {
      const result = await this.authUseCase.loginWithPrivy({
        privyToken: body.privyToken,
        telegramChatId: body.telegramChatId,
      });
      userId = result.userId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ reason: msg }, "auth loginWithPrivy failed");
      return this.sendJson(res, 401, { error: 'Unauthorized' });
    }

    const chatId = parseInt(body.telegramChatId, 10);

    await this.telegramNotifier?.sendMessage(String(chatId), "You're signed in. Try asking me anything.");

    await this.miniAppRequestCache!.delete(body.requestId);

    let approveRequestId: string | undefined;
    if (this.userProfileDB && this.miniAppRequestCache) {
      const profile = await this.userProfileDB.findByUserId(userId);
      if (!profile?.sessionKeyAddress) {
        const now = newCurrentUTCEpoch();
        const approveRequest: ApproveRequest = {
          requestId: newUuid(),
          requestType: 'approve',
          subtype: 'session_key',
          userId,
          createdAt: now,
          expiresAt: now + 600,
        };
        await this.miniAppRequestCache.store(approveRequest);
        approveRequestId = approveRequest.requestId;
      }
    }

    return this.sendJson(res, 200, { requestId: body.requestId, ok: true, approveRequestId });
  }

  private async handleSignMiniAppResponse(
    body: SignResponse,
    userId: string,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.signingRequestUseCase) {
      return this.sendJson(res, 503, { error: 'Signing service not available' });
    }

    try {
      await this.signingRequestUseCase.resolveRequest({
        requestId: body.requestId,
        userId,
        txHash: body.txHash,
        rejected: body.rejected,
        errorCode: body.errorCode,
        errorMessage: body.errorMessage,
        errorRaw: body.errorRaw,
      });
    } catch (err) {
      const message = toErrorMessage(err);
      // Drop the mini-app entry on any terminal resolution outcome so the
      // FE's `?after=<id>` poll stops returning the same stale request and
      // looping. Without this, a NOT_FOUND/EXPIRED leaves the queue entry
      // alive until TTL — and the FE keeps re-acking + re-fetching at
      // hundreds of req/s, hammering the BE.
      if (
        message === 'SIGNING_REQUEST_NOT_FOUND' ||
        message === 'SIGNING_REQUEST_EXPIRED' ||
        message === 'SIGNING_REQUEST_FORBIDDEN' ||
        message === 'SIGNING_REQUEST_DUPLICATE_HASH'
      ) {
        await this.miniAppRequestCache!.delete(body.requestId).catch(() => undefined);
      }
      if (message === 'SIGNING_REQUEST_NOT_FOUND') return this.sendJson(res, 404, { error: 'Request not found' });
      if (message === 'SIGNING_REQUEST_EXPIRED') return this.sendJson(res, 410, { error: 'Request expired' });
      if (message === 'SIGNING_REQUEST_FORBIDDEN') return this.sendJson(res, 403, { error: 'Forbidden' });
      // Stale-hash reuse: the FE handed us a txHash already consumed by a
      // different recent requestId for this user. 409 Conflict is the
      // semantically correct status; the FE doesn't currently surface a
      // toast for it (we want quiet failure since the upstream cause is
      // the FE itself reusing the hash) but logs make it investigable.
      if (message === 'SIGNING_REQUEST_DUPLICATE_HASH') return this.sendJson(res, 409, { error: 'Stale txHash — already consumed by a prior request' });
      throw err;
    }

    await this.miniAppRequestCache!.delete(body.requestId);
    return this.sendJson(res, 200, { requestId: body.requestId, ok: true });
  }

  private async handleApproveMiniAppResponse(
    body: ApproveResponse,
    userId: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const chatIdStr = await this.resolveChatId(userId);

    if (body.rejected) {
      if (chatIdStr) {
        await this.telegramNotifier?.sendMessage(chatIdStr, 'Setup cancelled.');
      }
      await this.miniAppRequestCache!.delete(body.requestId);
      // Drop any stashed pending intent so it doesn't auto-resume on a stale
      // approval requestId after the user explicitly cancelled.
      await this.pendingIntentStore?.delete(body.requestId).catch(() => undefined);
      return this.sendJson(res, 200, { requestId: body.requestId, ok: true });
    }

    if (body.subtype === 'session_key' && body.delegationRecord) {
      const err = await this.applySessionKeyApproval(userId, body.delegationRecord, chatIdStr);
      if (err) return this.sendJson(res, err.status, { error: err.message });
    } else if (body.subtype === 'aegis_guard' && body.aegisGrant) {
      await this.applyAegisGuardApproval(userId, chatIdStr, body.requestId);
    }

    await this.miniAppRequestCache!.delete(body.requestId);
    return this.sendJson(res, 200, { requestId: body.requestId, ok: true });
  }

  private async applySessionKeyApproval(
    userId: string,
    delegationRecord: MiniAppDelegationRecord,
    chatIdStr: string | null,
  ): Promise<{ status: number; message: string } | null> {
    if (!this.sessionDelegationUseCase) {
      return { status: 503, message: 'Session delegation service not available' };
    }
    await this.sessionDelegationUseCase.save(delegationRecord as unknown as SessionDelegationRecord);

    if (this.userProfileDB) {
      const now = newCurrentUTCEpoch();
      const existing = await this.userProfileDB.findByUserId(userId);
      const { smartAccountAddress, signerAddress, address: sessionKeyAddress } = delegationRecord;
      if (!existing) {
        await this.userProfileDB.upsert({
          userId,
          smartAccountAddress,
          eoaAddress: signerAddress,
          sessionKeyAddress,
          createdAtEpoch: now,
          updatedAtEpoch: now,
        });
      } else {
        await this.userProfileDB.update({
          userId,
          telegramChatId: existing.telegramChatId,
          smartAccountAddress,
          eoaAddress: existing.eoaAddress ?? signerAddress,
          sessionKeyAddress,
          sessionKeyScope: existing.sessionKeyScope,
          sessionKeyStatus: existing.sessionKeyStatus,
          sessionKeyExpiresAtEpoch: existing.sessionKeyExpiresAtEpoch,
          updatedAtEpoch: now,
        });
      }
    }

    if (chatIdStr) {
      await this.telegramNotifier?.sendMessage(chatIdStr, 'Session key installed. You can now execute transactions.');
    }
    return null;
  }

  private async applyAegisGuardApproval(
    userId: string,
    chatIdStr: string | null,
    approvalRequestId: string,
  ): Promise<void> {
    if (this.userPreferencesRepo) {
      await this.userPreferencesRepo.upsert(userId, { aegisGuardEnabled: true });
    }

    // Auto-resume the original /send or /swap that triggered this approval,
    // if one was stashed under this approvalRequestId. The user is notified
    // before the resumed run emits its own mini-app prompt.
    const pending = this.pendingIntentStore
      ? await this.pendingIntentStore.get(approvalRequestId).catch((err) => {
          log.error({ err, approvalRequestId }, "pending-intent lookup failed");
          return null;
        })
      : null;

    if (!pending) {
      if (chatIdStr) {
        await this.telegramNotifier?.sendMessage(chatIdStr, 'Aegis Guard enabled.');
      }
      return;
    }

    const dispatcher = this.getCapabilityDispatcher
      ? await this.getCapabilityDispatcher().catch(() => undefined)
      : undefined;
    if (!dispatcher) {
      // No dispatcher in this replica — surface the approval and bail out.
      // The user retains the cached intent until it expires; they can re-issue
      // the command manually.
      log.warn(
        { approvalRequestId, capabilityId: pending.capabilityId },
        "approval landed without a dispatcher — cannot auto-resume",
      );
      if (chatIdStr) {
        await this.telegramNotifier?.sendMessage(chatIdStr, 'Aegis Guard enabled.');
      }
      await this.pendingIntentStore?.delete(approvalRequestId).catch(() => undefined);
      return;
    }

    if (chatIdStr) {
      await this.telegramNotifier?.sendMessage(
        chatIdStr,
        'Aegis Guard enabled. Resuming your previous request…',
      );
    }

    log.info(
      { step: "approval-resumed", userId, approvalRequestId, capabilityId: pending.capabilityId },
      "auto-resuming intent after approval",
    );

    // Fire-and-forget: /swap re-runs `capability.run` which awaits each step's
    // signing response (up to SIGN_WAIT_TIMEOUT_MS = 10 min). If we awaited it
    // here, the FE's POST /response would hang for the entire user-signing
    // session and the mini-app would never close cleanly. The resume path
    // emits its own Telegram artifacts via the renderer, so the user sees
    // progress through the bot even though the HTTP call has already returned.
    void (async () => {
      try {
        await dispatcher.resume({
          capabilityId: pending.capabilityId,
          params: pending.params,
          ctx: {
            userId: pending.userId,
            channelId: pending.channelId,
          },
        });
      } catch (err) {
        log.error(
          { err, approvalRequestId, capabilityId: pending.capabilityId, userId },
          "resume after approval failed",
        );
        if (chatIdStr) {
          await this.telegramNotifier
            ?.sendMessage(
              chatIdStr,
              'Approval succeeded, but I could not resume your previous request automatically. Please re-send the command.',
            )
            .catch(() => undefined);
        }
      } finally {
        await this.pendingIntentStore?.delete(approvalRequestId).catch(() => undefined);
      }
    })();
  }

  private async resolveChatId(userId: string): Promise<string | null> {
    if (!this.telegramSessionRepo) return null;
    const session = await this.telegramSessionRepo.findByUserId(userId);
    return session ? session.telegramChatId : null;
  }

  private async handleGetPreference(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.userPreferencesRepo) return this.sendJson(res, 503, { error: "Preferences service not available" });

    const pref = await this.userPreferencesRepo.findByUserId(userId);
    return this.sendJson(res, 200, { aegisGuardEnabled: pref?.aegisGuardEnabled ?? false });
  }

  private async handlePostPreference(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.userPreferencesRepo) return this.sendJson(res, 503, { error: "Preferences service not available" });

    const reqId = this.reqLogIds.get(req) ?? "?";
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ reqId, path: "POST /preference", err: msg }, "invalid-json-body");
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = z.object({ aegisGuardEnabled: z.boolean() }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid request", details: parsed.error.issues });

    await this.userPreferencesRepo.upsert(userId, { aegisGuardEnabled: parsed.data.aegisGuardEnabled });
    return this.sendJson(res, 200, { ok: true });
  }

  // ── Delegation endpoints ────────────────────────────────────────────────────

  private async handleGetDelegationApprovalParams(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });

    // chainId defaults to the home chain; callers can override via ?chainId=…
    // for cross-chain delegation flows.
    const chainIdRaw = url.searchParams.get("chainId");
    const chainId = chainIdRaw ? parseInt(chainIdRaw, 10) : CHAIN_CONFIG.chainId;
    if (!Number.isFinite(chainId)) {
      return this.sendJson(res, 400, { error: "Invalid chainId" });
    }
    const nowEpoch = newCurrentUTCEpoch();
    const validUntil30Days = nowEpoch + 30 * 24 * 60 * 60;

    // USDC.bsc has 18 decimals — must source from registry, not assume 6.
    const usdcAddrForChain = getUsdcAddress(chainId);
    const native = getNativeTokenInfo(chainId);

    type TokenRow = {
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      suggestedLimitRaw: string;
      validUntil: number;
    };

    const requestedAddress = url.searchParams.get("tokenAddress");
    const requestedAmount = url.searchParams.get("amountRaw");
    const isReapproval = !!(requestedAddress && requestedAmount);

    const buildStableRow = (symbol: "USDC" | "USDT"): TokenRow => {
      const human = symbol === "USDC" ? DELEGATION_ENV.initialUsdc : DELEGATION_ENV.initialUsdt;
      return {
        tokenAddress: symbol === "USDC" ? (usdcAddrForChain ?? "") : "",
        tokenSymbol: symbol,
        // Default to 6; hydrate() re-scales when the chain's USDC/USDT uses
        // different decimals (e.g. USDC.bsc is 18) so the human cap stays fixed.
        tokenDecimals: 6,
        suggestedLimitRaw: toRaw(String(human), 6),
        validUntil: validUntil30Days,
      };
    };
    const nativeRow: TokenRow | null = native
      ? {
          tokenAddress: native.address,
          tokenSymbol: native.symbol,
          tokenDecimals: native.decimals,
          suggestedLimitRaw: toRaw(String(DELEGATION_ENV.initialNative), native.decimals),
          validUntil: validUntil30Days,
        }
      : null;

    const registryTokens = this.portfolioUseCase
      ? await this.portfolioUseCase.listTokens(chainId).catch(() => [])
      : [];

    const hydrate = (row: TokenRow): TokenRow => {
      const found = registryTokens.find(
        (rt) => rt.symbol.toUpperCase() === row.tokenSymbol.toUpperCase(),
      );
      if (!found) return row;
      const next = { ...row };
      if (!next.tokenAddress) next.tokenAddress = found.address;
      if (next.tokenDecimals !== found.decimals) {
        const oldDec = next.tokenDecimals;
        next.tokenDecimals = found.decimals;
        const scale = 10n ** BigInt(Math.abs(found.decimals - oldDec));
        next.suggestedLimitRaw =
          found.decimals > oldDec
            ? (BigInt(next.suggestedLimitRaw) * scale).toString()
            : (BigInt(next.suggestedLimitRaw) / scale).toString();
      }
      return next;
    };

    let resolved: TokenRow[];

    if (!isReapproval) {
      resolved = [
        hydrate(buildStableRow("USDC")),
        hydrate(buildStableRow("USDT")),
        ...(nativeRow ? [nativeRow] : []),
      ].filter((t) => !!t.tokenAddress);
    } else {
      // FE forwards the same (tokenAddress, amountRaw) to every onboarding
      // chain — non-stable mode returns [] on chains where the token doesn't
      // exist; stable mode refreshes both stables on every chain.
      const failingToken = registryTokens.find(
        (rt) => rt.address.toLowerCase() === requestedAddress!.toLowerCase(),
      );
      const isStableMode = failingToken ? STABLE_SYMBOLS.has(failingToken.symbol.toUpperCase()) : false;

      if (isStableMode) {
        resolved = [
          hydrate(buildStableRow("USDC")),
          hydrate(buildStableRow("USDT")),
        ].filter((t) => !!t.tokenAddress);
        log.debug({ chainId, mode: "stable-reapproval" }, "approval-params reapproval");
      } else if (failingToken) {
        resolved = [
          {
            tokenAddress: failingToken.address,
            tokenSymbol: failingToken.symbol,
            tokenDecimals: failingToken.decimals,
            suggestedLimitRaw: requestedAmount!,
            validUntil: validUntil30Days,
          },
        ];
        log.debug(
          { chainId, mode: "non-stable-reapproval", tokenSymbol: failingToken.symbol },
          "approval-params reapproval",
        );
      } else {
        resolved = [];
        log.debug(
          { chainId, requestedAddress, choice: "skipped-not-on-chain" },
          "approval-params reapproval skipped",
        );
      }
    }

    return this.sendJson(res, 200, { tokens: resolved });
  }

  private async handlePostDelegationGrant(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.tokenDelegationRepo) return this.sendJson(res, 503, { error: "Delegation service not available" });

    const reqId = this.reqLogIds.get(req) ?? "?";
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ reqId, path: "POST /delegation/grant", err: msg }, "invalid-json-body");
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = z.object({
      delegations: z.array(z.object({
        tokenAddress: z.string().min(1),
        tokenSymbol: z.string().min(1).max(10),
        tokenDecimals: z.number().int().min(0).max(18),
        limitRaw: z.string().regex(/^\d+$/),
        validUntil: z.number().int().positive(),
      })).min(1),
    }).safeParse(body);

    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid request", details: parsed.error.issues });

    const delegations: NewTokenDelegation[] = parsed.data.delegations;
    await this.tokenDelegationRepo.upsertMany(userId, delegations);
    return this.sendJson(res, 200, { ok: true });
  }

  private async handleGetDelegationGrant(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.tokenDelegationRepo) return this.sendJson(res, 503, { error: "Delegation service not available" });

    const delegations = await this.tokenDelegationRepo.findActiveByUserId(userId);
    return this.sendJson(res, 200, { delegations });
  }

  /**
   * Returns the per-token spending caps the FE must seed into the on-chain
   * `toSpendingLimitPolicy` at session-key install. Source of truth is
   * `tokenDelegation` rows — same rows that drive `aegisGuardInterceptor`.
   * Optional `?chainId=` filter; defaults to home chain. Tokens with no
   * delegation row are simply absent — installer translates "absent" as
   * "cap = 0", which is the conservative default.
   */
  private async handleGetDelegationSpendingLimits(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const reqId = this.reqLogIds.get(req) ?? "?";
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.tokenDelegationRepo) return this.sendJson(res, 503, { error: "Delegation service not available" });

    const chainIdRaw = url.searchParams.get("chainId");
    const chainId = chainIdRaw ? parseInt(chainIdRaw, 10) : CHAIN_CONFIG.chainId;
    if (!Number.isFinite(chainId)) {
      return this.sendJson(res, 400, { error: "Invalid chainId" });
    }

    const delegations = await this.tokenDelegationRepo.findActiveByUserId(userId);
    const limits = delegations.map((d) => ({
      token: d.tokenAddress,
      cap: d.limitRaw,
      validUntil: d.validUntil,
    }));

    log.info({ reqId, userId, chainId, count: limits.length }, "spending-limits served");
    return this.sendJson(res, 200, { chainId, limits });
  }

  /**
   * Revoke the user's session key. Wipes:
   *   - Redis sessionDelegation cache entry (so the BE no longer recognises
   *     the session key when it sees signed userOps).
   *   - All token_delegations rows for this user (so Aegis Guard re-prompts
   *     for approval on the next /send or /swap).
   *   - userProfile.sessionKey* fields (status flipped to REVOKED, address
   *     cleared) — historical audit lives via updatedAtEpoch.
   *
   * Onchain plugin invalidation is handled on the FE before this endpoint is
   * called: the user signs a sudo userOp with their Privy EOA to invalidate
   * the kernel nonce, which voids every spending-cap policy attached to the
   * regular validator. This endpoint records the offchain truth.
   */
  private async handlePostDelegationRevoke(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const reqId = this.reqLogIds.get(req) ?? "?";
    const start = Date.now();
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });

    log.info({ reqId, userId, step: "started" }, "delegation revoke");

    const profile = this.userProfileDB ? await this.userProfileDB.findByUserId(userId) : undefined;
    const sessionKeyAddress = profile?.sessionKeyAddress ?? null;

    // Best-effort: each step is independent, and we want the request to clean
    // up as much as possible even if a downstream system is briefly down.
    let cacheRevoked = false;
    if (this.sessionDelegationUseCase && sessionKeyAddress) {
      try {
        await this.sessionDelegationUseCase.revoke(sessionKeyAddress);
        cacheRevoked = true;
      } catch (err) {
        log.error({ err, reqId, userId, sessionKeyAddress }, "redis-delegation-revoke-failed");
      }
    }

    let deletedDelegations = 0;
    if (this.tokenDelegationRepo) {
      try {
        deletedDelegations = await this.tokenDelegationRepo.deleteAllByUserId(userId);
      } catch (err) {
        log.error({ err, reqId, userId }, "token-delegation-delete-failed");
      }
    }

    if (this.userProfileDB && profile) {
      try {
        const now = newCurrentUTCEpoch();
        await this.userProfileDB.update({
          userId,
          telegramChatId: profile.telegramChatId,
          smartAccountAddress: profile.smartAccountAddress,
          eoaAddress: profile.eoaAddress,
          sessionKeyAddress: null,
          sessionKeyScope: null,
          sessionKeyStatus: SESSION_KEY_STATUSES.REVOKED,
          sessionKeyExpiresAtEpoch: null,
          updatedAtEpoch: now,
        });
      } catch (err) {
        log.error({ err, reqId, userId }, "user-profile-revoke-update-failed");
      }
    }

    log.info(
      {
        reqId,
        userId,
        step: "succeeded",
        cacheRevoked,
        sessionKeyAddress,
        deletedDelegations,
        durationMs: Date.now() - start,
      },
      "delegation revoke complete",
    );
    return this.sendJson(res, 200, { ok: true, deletedDelegations });
  }

  private async handleGetLoyaltyBalance(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.loyaltyUseCase) return this.sendJson(res, 503, { error: "Loyalty service not available" });

    const balance = await this.loyaltyUseCase.getBalance(userId);
    return this.sendJson(res, 200, {
      seasonId: balance.seasonId,
      pointsTotal: balance.pointsTotal.toString(),
      rank: balance.rank,
    });
  }

  private async handleGetLoyaltyHistory(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.loyaltyUseCase) return this.sendJson(res, 503, { error: "Loyalty service not available" });

    const limitStr = url.searchParams.get("limit");
    const cursorStr = url.searchParams.get("cursorCreatedAtEpoch");
    const limit = Math.min(limitStr ? parseInt(limitStr, 10) : 20, 100);
    const cursor = cursorStr ? parseInt(cursorStr, 10) : undefined;

    const entries = await this.loyaltyUseCase.getHistory(userId, { limit, cursorCreatedAtEpoch: cursor });
    const nextCursor = entries.length === limit ? entries[entries.length - 1].createdAtEpoch : null;
    return this.sendJson(res, 200, {
      entries: entries.map((e) => ({
        actionType: e.actionType,
        points: e.pointsRaw.toString(),
        createdAtEpoch: e.createdAtEpoch,
      })),
      nextCursor,
    });
  }

  private async handleGetLoyaltyLeaderboard(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.loyaltyUseCase) return this.sendJson(res, 503, { error: "Loyalty service not available" });

    const limitStr = url.searchParams.get("limit");
    const limit = Math.min(limitStr ? parseInt(limitStr, 10) : LOYALTY_ENV.leaderboardDefaultLimit, LOYALTY_ENV.leaderboardMaxLimit);

    const requestedSeasonId = url.searchParams.get("seasonId");
    const activeSeasonId = requestedSeasonId ?? (await this.loyaltyUseCase.getActiveSeasonId());
    if (!activeSeasonId) {
      return this.sendJson(res, 200, { seasonId: null, entries: [] });
    }
    const { entries, seasonId } = await this.loyaltyUseCase.getLeaderboard(activeSeasonId, limit);
    return this.sendJson(res, 200, {
      seasonId,
      entries: entries.map((e) => ({
        rank: e.rank,
        pointsTotal: e.pointsTotal.toString(),
      })),
    });
  }

  private async handleGetMetrics(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (METRICS_TOKEN) {
      const header = req.headers["authorization"];
      if (header !== `Bearer ${METRICS_TOKEN}`) {
        res.statusCode = 401;
        res.end();
        return;
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(metricsRegistry.snapshot()));
  }

  private async handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqId = this.reqLogIds.get(req) ?? '?';
    const start = Date.now();

    const mem = process.memoryUsage();
    const toMb = (n: number) => Math.round((n / 1024 / 1024) * 100) / 100;

    const subgraphStatus = this.subgraphPrincipalProvider?.status() ?? "disabled";

    const services: Record<string, boolean | string> = {
      subgraph: subgraphStatus,
      auth: true,
      intent: !!this.intentUseCase,
      portfolio: !!this.portfolioUseCase,
      sessionDelegation: !!this.sessionDelegationUseCase,
      pendingDelegation: !!this.pendingDelegationRepo,
      miniAppRequest: !!this.miniAppRequestCache,
      signingRequest: !!this.signingRequestUseCase,
      userProfileCache: !!this.userProfileCache,
      userPreferences: !!this.userPreferencesRepo,
      tokenDelegation: !!this.tokenDelegationRepo,
      userProfileDB: !!this.userProfileDB,
      telegramSession: !!this.telegramSessionRepo,
      telegramNotifier: !!this.telegramNotifier,
      yieldOptimizer: !!this.yieldOptimizerUseCase,
      loyalty: !!this.loyaltyUseCase,
      transferHistory: !!this.transferHistoryUseCase,
    };

    const now = newCurrentUTCEpoch();
    const payload = {
      status: "ok" as const,
      service: "memora-be",
      version: process.env.SERVICE_VERSION ?? "unknown",
      processRole: process.env.PROCESS_ROLE ?? "unknown",
      nodeEnv: process.env.NODE_ENV ?? "development",
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      chain: {
        chainId: CHAIN_CONFIG.chainId,
        name: CHAIN_CONFIG.name,
        nativeSymbol: CHAIN_CONFIG.nativeSymbol,
      },
      uptimeSeconds: Math.round(process.uptime()),
      startedAtEpoch: this.startedAtEpoch,
      timestampEpoch: now,
      memoryMb: {
        rss: toMb(mem.rss),
        heapUsed: toMb(mem.heapUsed),
        heapTotal: toMb(mem.heapTotal),
        external: toMb(mem.external),
      },
      services,
    };

    log.info({ reqId, step: "succeeded", durationMs: Date.now() - start }, "health check");
    return this.sendJson(res, 200, payload);
  }

  private async handleGetYieldPositions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.yieldOptimizerUseCase) return this.sendJson(res, 503, { error: "Yield service not available" });

    const result = await this.yieldOptimizerUseCase.getPositions(userId);
    return this.sendJson(res, 200, result);
  }

  private async requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
    const userId = await this.extractUserId(req);
    if (!userId) { this.sendJson(res, 401, { error: "unauthorized" }); return null; }
    const user = await this.userDB?.findById(userId);
    if (!user?.privyDid || !ADMIN_PRIVY_DIDS.has(user.privyDid)) {
      log.warn({ userId }, "admin-forbidden");
      this.sendJson(res, 403, { error: "forbidden" });
      return null;
    }
    return userId;
  }

  private async handlePmSetupInit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    try {
      const setup = await this.predictionMarketBetUseCase.ensureUserSetup(userId);
      return this.sendJson(res, 200, setup);
    } catch (err) {
      log.error({ err, userId }, "pm-setup-init-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handlePmSetupStep(req: http.IncomingMessage, res: http.ServerResponse, step: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    if (!(SETUP_STEPS as readonly string[]).includes(step)) {
      return this.sendJson(res, 400, { error: "Invalid step" });
    }
    let body: unknown = {};
    try { body = await this.readJson(req); } catch { /* empty body acceptable */ }
    const parsed = z.object({
      bridgeIntentId: z.string().min(1).optional(),
      approvalsTxHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).optional(),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid payload", details: parsed.error.issues });
    try {
      const setup = await this.predictionMarketBetUseCase.recordSetupStep(
        userId,
        step as (typeof SETUP_STEPS)[number],
        parsed.data,
      );
      return this.sendJson(res, 200, setup);
    } catch (err) {
      log.error({ err, userId, step }, "pm-setup-step-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handlePmSetupCreds(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }
    const parsed = z.object({
      apiKey: z.string().min(1),
      secret: z.string().min(1),
      passphrase: z.string().min(1),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid creds" });
    try {
      await this.predictionMarketBetUseCase.storePolymarketCreds(userId, parsed.data);
      return this.sendJson(res, 204, {});
    } catch (err) {
      log.error({ err, userId }, "pm-setup-creds-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handlePmState(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    const [setup, intent, positions] = await Promise.all([
      this.predictionMarketBetUseCase.ensureUserSetup(userId).catch(() => null),
      this.predictionMarketBetUseCase.getActiveIntent(userId),
      this.predictionMarketBetUseCase.listOpenPositions(userId),
    ]);
    return this.sendJson(res, 200, { setup, activeIntent: intent, openPositions: positions });
  }

  private async handlePmActiveIntent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    const intent = await this.predictionMarketBetUseCase.getActiveIntent(userId);
    if (!intent) return this.sendJson(res, 404, { error: "No active intent" });
    return this.sendJson(res, 200, intent);
  }

  private async handlePmGetIntent(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    const intent = await this.predictionMarketBetUseCase.getBetIntent(userId, id);
    if (!intent) return this.sendJson(res, 404, { error: "Not found" });
    return this.sendJson(res, 200, intent);
  }

  private async handlePmCancelIntent(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    await this.predictionMarketBetUseCase.cancelBetIntent(userId, id);
    return this.sendJson(res, 204, {});
  }

  private async handlePmGetBet(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    const bet = await this.predictionMarketBetUseCase.getBet(userId, id);
    if (!bet) return this.sendJson(res, 404, { error: "Not found" });
    return this.sendJson(res, 200, bet);
  }

  private async handlePmTransitionBet(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }
    const parsed = z.object({
      // Only non-terminal transitions go through this endpoint; FILLED/PARTIAL/
      // UNFILLED/FAILED route through `/finalize` so the use-case can write
      // positions and refunds atomically with the status flip.
      status: z.enum(BET_TRANSITION_STATUSES),
      bridgeIntentId: z.string().optional(),
      scaToEoaTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
      polymarketOrderId: z.string().optional(),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid payload", details: parsed.error.issues });
    try {
      const { status, ...patch } = parsed.data;
      const fresh = await this.predictionMarketBetUseCase.transitionBet(userId, id, status, patch);
      return this.sendJson(res, 200, fresh);
    } catch (err) {
      if (err instanceof IllegalBetTransitionError) {
        // 409 Conflict — the FE state machine drifted from the canonical one.
        // Surfacing this distinctly lets the FE show "this bet has moved on,
        // refresh" rather than treating it as a generic 5xx.
        log.warn({ userId, betId: id, from: err.from, to: err.to }, "pm-bet-illegal-transition");
        return this.sendJson(res, 409, { error: err.message, from: err.from, to: err.to });
      }
      log.error({ err, userId, betId: id }, "pm-bet-transition-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handlePmFinalizeBet(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }
    const parsed = z.object({
      outcome: z.enum(BET_TERMINAL_STATUSES),
      filledShares: z.string().optional(),
      filledAvgPriceBps: z.number().int().min(0).max(10_000).optional(),
      failureReason: z.string().max(256).optional(),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid payload", details: parsed.error.issues });
    try {
      const result = await this.predictionMarketBetUseCase.finalizeBet({
        userId,
        betId: id,
        ...parsed.data,
      });
      // Receipt push is fire-and-forget — failures here mustn't fail the
      // request, since the FE already has canonical state from the response.
      this.predictionMarketReceiptBroadcaster
        ?.broadcastFinalizeOutcome({
          userId,
          outcome: parsed.data.outcome,
          bet: result.bet,
          position: result.position,
          closedPosition: result.closedPosition,
        })
        .catch((err) => log.warn({ err, userId, betId: id }, "pm-receipt-push-failed"));
      return this.sendJson(res, 200, result);
    } catch (err) {
      log.error({ err, userId, betId: id }, "pm-bet-finalize-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handlePmOrderbook(req: http.IncomingMessage, res: http.ServerResponse, tokenId: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.polymarketAdapter) return this.sendJson(res, 503, { error: "Not available" });
    try {
      const tob = await this.polymarketAdapter.getOrderbookTopOfBook(tokenId);
      return this.sendJson(res, 200, tob);
    } catch (err) {
      log.warn({ err, tokenId }, "pm-orderbook-failed");
      return this.sendJson(res, 502, { error: toErrorMessage(err) });
    }
  }

  private async handlePmPlaceOrder(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.polymarketAdapter || !this.predictionMarketBetUseCase) {
      return this.sendJson(res, 503, { error: "Not available" });
    }
    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }
    const parsed = z.object({
      betId: z.string().uuid(),
      clientOrderId: z.string().min(1),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      order: z.object({
        salt: z.string(), maker: z.string(), signer: z.string(), taker: z.string(),
        tokenId: z.string(), makerAmount: z.string(), takerAmount: z.string(),
        expiration: z.string(), nonce: z.string(), feeRateBps: z.string(),
        side: z.enum(["BUY", "SELL"]),
        signatureType: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      }),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid order", details: parsed.error.issues });

    const [bet, setup] = await Promise.all([
      this.predictionMarketBetUseCase.getBet(userId, parsed.data.betId),
      this.predictionMarketBetUseCase.ensureUserSetup(userId),
    ]);
    if (!bet) return this.sendJson(res, 404, { error: "Bet not found" });
    if (!setup.polymarketCredsEnc) return this.sendJson(res, 412, { error: "Polymarket auth missing" });

    try {
      const result = await this.polymarketAdapter.placeOrder({
        signature: parsed.data.signature as `0x${string}`,
        order: {
          ...parsed.data.order,
          maker: parsed.data.order.maker as `0x${string}`,
          signer: parsed.data.order.signer as `0x${string}`,
          taker: parsed.data.order.taker as `0x${string}`,
        },
        clientOrderId: parsed.data.clientOrderId,
        polymarketCredsEnc: setup.polymarketCredsEnc,
        makerAddress: setup.polygonEoaAddress as `0x${string}`,
        userId,
      });
      return this.sendJson(res, 200, result);
    } catch (err) {
      log.error({ err, userId, betId: parsed.data.betId }, "pm-place-order-failed");
      return this.sendJson(res, 502, { error: toErrorMessage(err) });
    }
  }

  private async handlePmCancelOrder(req: http.IncomingMessage, res: http.ServerResponse, polymarketOrderId: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.polymarketAdapter || !this.predictionMarketBetUseCase) {
      return this.sendJson(res, 503, { error: "Not available" });
    }
    const setup = await this.predictionMarketBetUseCase.ensureUserSetup(userId);
    if (!setup.polymarketCredsEnc) return this.sendJson(res, 412, { error: "Polymarket auth missing" });
    try {
      await this.polymarketAdapter.cancelOrder(
        polymarketOrderId,
        setup.polymarketCredsEnc,
        setup.polygonEoaAddress as `0x${string}`,
      );
      return this.sendJson(res, 204, {});
    } catch (err) {
      log.warn({ err, userId, polymarketOrderId }, "pm-cancel-order-failed");
      return this.sendJson(res, 502, { error: toErrorMessage(err) });
    }
  }

  private async handlePmListPositions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    const positions = await this.predictionMarketBetUseCase.listOpenPositions(userId);
    return this.sendJson(res, 200, positions);
  }

  private async handlePmBridgeStatus(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase || !this.relayClient) {
      return this.sendJson(res, 503, { error: "Not available" });
    }
    const bet = await this.predictionMarketBetUseCase.getBet(userId, id);
    if (!bet) return this.sendJson(res, 404, { error: "Bet not found" });
    if (!bet.bridgeIntentId) {
      // No bridge in flight — the FE shouldn't be polling yet. Surface a
      // distinct shape so the FE can short-circuit instead of looping.
      return this.sendJson(res, 200, { status: "no-intent" });
    }
    try {
      const result = await this.relayClient.getIntentStatus(bet.bridgeIntentId);
      return this.sendJson(res, 200, result);
    } catch (err) {
      log.warn({ err, userId, betId: id, bridgeIntentId: bet.bridgeIntentId }, "pm-bridge-status-failed");
      return this.sendJson(res, 502, { error: toErrorMessage(err) });
    }
  }

  private async handlePmDriftDetected(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }
    const parsed = z.object({
      livePriceBps: z.number().int().min(0).max(10_000),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid payload", details: parsed.error.issues });
    try {
      const result = await this.predictionMarketBetUseCase.reportPriceDrift({
        userId,
        betId: id,
        livePriceBps: parsed.data.livePriceBps,
      });
      return this.sendJson(res, 200, result);
    } catch (err) {
      log.warn({ err, userId, betId: id }, "pm-drift-detected-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async handlePmRecordRefund(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.predictionMarketBetUseCase) return this.sendJson(res, 503, { error: "Not available" });
    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }
    const parsed = z.object({
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }).safeParse(body);
    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid payload", details: parsed.error.issues });
    try {
      const fresh = await this.predictionMarketBetUseCase.recordRefundTxHash(userId, id, parsed.data.txHash);
      return this.sendJson(res, 200, fresh);
    } catch (err) {
      log.error({ err, userId, betId: id }, "pm-refund-record-failed");
      return this.sendJson(res, 500, { error: toErrorMessage(err) });
    }
  }

  private async extractUserId(req: http.IncomingMessage): Promise<string | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return null;
    return this.authUseCase.resolveUserId(authHeader.slice(7));
  }

  private readJson(req: http.IncomingMessage): Promise<unknown> {
    const reqId = this.reqLogIds.get(req) ?? '?';
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          log.debug({ reqId, bodyBytes: body.length }, "request body parsed");
          resolve(parsed);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          reject(new Error(`Invalid JSON: ${msg}`));
        }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const reqId = this.resLogIds.get(res) ?? '?';
    log.info({ reqId, status }, "response sent");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  start(): void {
    this.server.listen(this.port, () => {
      log.info({ port: this.port }, "HTTP API server listening");
    });
  }

  stop(): void {
    this.server.close();
  }
}
