import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import type { IToolRegistrationUseCase } from "../../../../use-cases/interface/input/toolRegistration.interface";
import type { ISessionDelegationUseCase } from "../../../../use-cases/interface/input/sessionDelegation.interface";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { ICommandMappingUseCase } from "../../../../use-cases/interface/input/commandMapping.interface";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { IHttpQueryToolUseCase } from "../../../../use-cases/interface/input/httpQueryTool.interface";
import type { IUserPreferencesDB } from "../../../../use-cases/interface/output/repository/userPreference.repo";
import type { ITokenDelegationDB, NewTokenDelegation } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITelegramSessionDB } from "../../../../use-cases/interface/output/repository/telegramSession.repo";
import type { ITelegramNotifier } from "../../../../use-cases/interface/output/telegramNotifier.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { IYieldOptimizerUseCase } from "../../../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { ILoyaltyUseCase } from "../../../../use-cases/interface/input/loyalty.interface";
import { LOYALTY_ENV } from "../../../../helpers/env/loyaltyEnv";
import type {
  MiniAppResponse,
  AuthResponse,
  SignResponse,
  ApproveResponse,
  ApproveRequest,
  DelegationRecord as MiniAppDelegationRecord,
} from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { DelegationRecord as SessionDelegationRecord } from "../../../../use-cases/interface/output/cache/sessionDelegation.cache";
import { ToolManifestSchema } from "../../../../use-cases/interface/output/toolManifest.types";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import { metricsRegistry } from "../../../../helpers/observability/metricsRegistry";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("httpServer");
const METRICS_TOKEN = process.env.METRICS_TOKEN;

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
    private readonly toolRegistrationUseCase?: IToolRegistrationUseCase,
    private readonly sessionDelegationUseCase?: ISessionDelegationUseCase,
    private readonly pendingDelegationRepo?: IPendingDelegationDB,
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
    private readonly signingRequestUseCase?: ISigningRequestUseCase,
    private readonly commandMappingUseCase?: ICommandMappingUseCase,
    private readonly userProfileCache?: IUserProfileCache,
    private readonly httpQueryToolUseCase?: IHttpQueryToolUseCase,
    private readonly userPreferencesRepo?: IUserPreferencesDB,
    private readonly tokenDelegationRepo?: ITokenDelegationDB,
    private readonly userProfileDB?: IUserProfileDB,
    private readonly telegramSessionRepo?: ITelegramSessionDB,
    private readonly telegramNotifier?: ITelegramNotifier,
    private readonly yieldOptimizerUseCase?: IYieldOptimizerUseCase,
    private readonly loyaltyUseCase?: ILoyaltyUseCase,
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
      "GET /tokens":                    (req, res, url) => this.handleGetTokens(req, res, url),
      "POST /tools":                    (req, res) => this.handlePostTools(req, res),
      "GET /tools":                     (req, res, url) => this.handleGetTools(req, res, url),
      "GET /permissions":               (req, res, url) => this.handleGetPermissions(req, res, url),
      "GET /delegation/pending":        (req, res) => this.handleGetPendingDelegation(req, res),
      "POST /response":                 (req, res) => this.handlePostResponse(req, res),
      "POST /command-mappings":         (req, res) => this.handlePostCommandMapping(req, res),
      "GET /command-mappings":          (req, res) => this.handleGetCommandMappings(req, res),
      "POST /http-tools":               (req, res) => this.handlePostHttpTool(req, res),
      "GET /http-tools":                (req, res) => this.handleGetHttpTools(req, res),
      "GET /preference":                (req, res) => this.handleGetPreference(req, res),
      "POST /preference":               (req, res) => this.handlePostPreference(req, res),
      "GET /delegation/approval-params": (req, res, url) => this.handleGetDelegationApprovalParams(req, res, url),
      "POST /delegation/grant":         (req, res) => this.handlePostDelegationGrant(req, res),
      "GET /delegation/grant":          (req, res) => this.handleGetDelegationGrant(req, res),
      "GET /yield/positions":           (req, res) => this.handleGetYieldPositions(req, res),
      "GET /loyalty/balance":           (req, res) => this.handleGetLoyaltyBalance(req, res),
      "GET /loyalty/history":           (req, res, url) => this.handleGetLoyaltyHistory(req, res, url),
      "GET /loyalty/leaderboard":       (req, res, url) => this.handleGetLoyaltyLeaderboard(req, res, url),
      "GET /metrics":                   (req, res) => this.handleGetMetrics(req, res),
      "POST /health":                   (req, res) => this.handleHealth(req, res),
    };
  }

  private get paramRoutes(): Array<[
    { method: string; regex: RegExp },
    (req: http.IncomingMessage, res: http.ServerResponse, url: URL, param: string) => Promise<void>
  ]> {
    return [
      [{ method: "DELETE", regex: /^\/tools\/([^/]+)$/ },             (req, res, url) => this.handleDeleteTool(req, res, url)],
      [{ method: "POST",   regex: /^\/delegation\/([^/]+)\/signed$/ }, (req, res, _u, id) => this.handlePostDelegationSigned(req, res, id)],
      [{ method: "GET",    regex: /^\/request\/([^/]+)$/ },           (req, res, url, requestId) => this.handleGetMiniAppRequest(req, res, url, requestId)],
      [{ method: "DELETE", regex: /^\/command-mappings\/(.+)$/ },     (req, res, _u, command) => this.handleDeleteCommandMapping(req, res, decodeURIComponent(command))],
      [{ method: "DELETE", regex: /^\/http-tools\/([^/]+)$/ },        (req, res, _u, id) => this.handleDeleteHttpTool(req, res, id)],
    ];
  }

  private async handlePrivyLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
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

  private async handleGetTokens(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.portfolioUseCase) {
      return this.sendJson(res, 503, { error: "Token registry not available" });
    }
    const chainIdStr = url.searchParams.get("chainId");
    const chainId = chainIdStr ? parseInt(chainIdStr, 10) : CHAIN_CONFIG.chainId;
    const tokens = await this.portfolioUseCase.listTokens(chainId);
    return this.sendJson(res, 200, { tokens });
  }

  private async handlePostTools(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.toolRegistrationUseCase) {
      return this.sendJson(res, 503, { error: "Tool registration service not available" });
    }

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = ToolManifestSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: "Invalid manifest", details: parsed.error.issues });
    }

    try {
      const result = await this.toolRegistrationUseCase.register(parsed.data);
      return this.sendJson(res, 201, result);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("TOOL_ID_TAKEN")) {
        return this.sendJson(res, 409, { error: "Tool ID already registered" });
      }
      throw err;
    }
  }

  private async handleDeleteTool(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.toolRegistrationUseCase) return this.sendJson(res, 503, { error: "Tool registration service not available" });

    const toolId = url.pathname.split("/").pop()?.trim();
    if (!toolId) return this.sendJson(res, 400, { error: "toolId is required" });

    try {
      await this.toolRegistrationUseCase.deactivate(toolId);
      return this.sendJson(res, 200, { toolId, deactivated: true });
    } catch (err) {
      const message = toErrorMessage(err);
      const status = message.startsWith("TOOL_NOT_FOUND") ? 404 : 500;
      return this.sendJson(res, status, { error: message });
    }
  }

  private async handleGetTools(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.toolRegistrationUseCase) {
      return this.sendJson(res, 503, { error: "Tool registration service not available" });
    }

    const chainIdStr = url.searchParams.get("chainId");
    const chainId = chainIdStr ? parseInt(chainIdStr, 10) : undefined;
    const tools = await this.toolRegistrationUseCase.list(chainId);
    return this.sendJson(res, 200, { tools });
  }

  private async handleGetPermissions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
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

    try {
      await this.pendingDelegationRepo.markSigned(id);
      return this.sendJson(res, 200, { id, signed: true });
    } catch (err) {
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
      if (next.expiresAt <= newCurrentUTCEpoch()) {
        return this.sendJson(res, 410, { error: 'Expired' });
      }
      return this.sendJson(res, 200, next);
    }

    const request = await this.miniAppRequestCache.retrieve(requestId);
    if (!request) return this.sendJson(res, 404, { error: 'Not found' });

    const now = newCurrentUTCEpoch();
    if (request.expiresAt <= now) return this.sendJson(res, 410, { error: 'Expired' });

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

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
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
      });
    } catch (err) {
      const message = toErrorMessage(err);
      if (message === 'SIGNING_REQUEST_NOT_FOUND') return this.sendJson(res, 404, { error: 'Request not found' });
      if (message === 'SIGNING_REQUEST_EXPIRED') return this.sendJson(res, 410, { error: 'Request expired' });
      if (message === 'SIGNING_REQUEST_FORBIDDEN') return this.sendJson(res, 403, { error: 'Forbidden' });
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
      return this.sendJson(res, 200, { requestId: body.requestId, ok: true });
    }

    if (body.subtype === 'session_key' && body.delegationRecord) {
      const err = await this.applySessionKeyApproval(userId, body.delegationRecord, chatIdStr);
      if (err) return this.sendJson(res, err.status, { error: err.message });
    } else if (body.subtype === 'aegis_guard' && body.aegisGrant) {
      await this.applyAegisGuardApproval(userId, chatIdStr);
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
  ): Promise<void> {
    if (this.userPreferencesRepo) {
      await this.userPreferencesRepo.upsert(userId, { aegisGuardEnabled: true });
    }
    if (chatIdStr) {
      await this.telegramNotifier?.sendMessage(chatIdStr, 'Aegis Guard enabled.');
    }
  }

  private async resolveChatId(userId: string): Promise<string | null> {
    if (!this.telegramSessionRepo) return null;
    const session = await this.telegramSessionRepo.findByUserId(userId);
    return session ? session.telegramChatId : null;
  }

  // ── Command mapping handlers ─────────────────────────────────────────────────

  private async handlePostCommandMapping(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.commandMappingUseCase) {
      return this.sendJson(res, 503, { error: "Command mapping service not available" });
    }
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }
    const parsed = z.object({
      command: z.string().min(1),
      toolId:  z.string().min(1),
    }).safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: "command and toolId are required", details: parsed.error.issues });
    }
    try {
      const result = await this.commandMappingUseCase.setMapping(parsed.data.command, parsed.data.toolId);
      return this.sendJson(res, 201, result);
    } catch (err) {
      const msg = toErrorMessage(err);
      if (msg.startsWith("UNKNOWN_COMMAND")) return this.sendJson(res, 400, { error: msg });
      if (msg.startsWith("TOOL_NOT_FOUND"))  return this.sendJson(res, 404, { error: msg });
      throw err;
    }
  }

  private async handleGetCommandMappings(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.commandMappingUseCase) {
      return this.sendJson(res, 503, { error: "Command mapping service not available" });
    }
    const mappings = await this.commandMappingUseCase.listMappings();
    return this.sendJson(res, 200, { mappings });
  }

  private async handleDeleteCommandMapping(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    command: string,
  ): Promise<void> {
    if (!this.commandMappingUseCase) {
      return this.sendJson(res, 503, { error: "Command mapping service not available" });
    }
    if (!command) return this.sendJson(res, 400, { error: "command is required" });
    try {
      await this.commandMappingUseCase.deleteMapping(command);
      return this.sendJson(res, 200, { command, deleted: true });
    } catch (err) {
      const msg = toErrorMessage(err);
      if (msg.startsWith("MAPPING_NOT_FOUND")) return this.sendJson(res, 404, { error: msg });
      throw err;
    }
  }

  private async handlePostHttpTool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.httpQueryToolUseCase) return this.sendJson(res, 503, { error: "HTTP tool service not available" });

    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }

    const parsed = z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "must be snake_case, start with letter, max 63 chars"),
      description: z.string().min(1),
      endpoint: z.string().url(),
      method: z.enum(["GET", "POST", "PUT"]),
      requestBodySchema: z.record(z.string(), z.unknown()),
      headers: z.array(z.object({
        key: z.string().min(1),
        value: z.string().min(1),
        encrypt: z.boolean(),
      })).default([]),
    }).safeParse(body);

    if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid request", details: parsed.error.issues });

    try {
      const result = await this.httpQueryToolUseCase.register({ userId, ...parsed.data });
      return this.sendJson(res, 201, result);
    } catch (err) {
      const msg = toErrorMessage(err);
      if (msg.startsWith("INVALID_TOOL_NAME")) return this.sendJson(res, 400, { error: msg });
      if (msg.startsWith("INVALID_ENDPOINT_URL")) return this.sendJson(res, 400, { error: msg });
      if (msg.startsWith("ENCRYPTION_KEY_NOT_CONFIGURED")) return this.sendJson(res, 503, { error: msg });
      throw err;
    }
  }

  private async handleGetHttpTools(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.httpQueryToolUseCase) return this.sendJson(res, 503, { error: "HTTP tool service not available" });

    const tools = await this.httpQueryToolUseCase.list(userId);
    return this.sendJson(res, 200, { tools });
  }

  private async handleDeleteHttpTool(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.httpQueryToolUseCase) return this.sendJson(res, 503, { error: "HTTP tool service not available" });
    if (!id) return this.sendJson(res, 400, { error: "Tool ID required" });

    try {
      await this.httpQueryToolUseCase.deactivate(id, userId);
      return this.sendJson(res, 200, { id, deactivated: true });
    } catch (err) {
      const msg = toErrorMessage(err);
      if (msg === "TOOL_NOT_FOUND") return this.sendJson(res, 404, { error: msg });
      if (msg === "TOOL_FORBIDDEN") return this.sendJson(res, 403, { error: msg });
      throw err;
    }
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

    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }

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

    const chainId = CHAIN_CONFIG.chainId;
    const nowEpoch = newCurrentUTCEpoch();
    const validUntil30Days = nowEpoch + 30 * 24 * 60 * 60;

    const NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const tokens: Array<{
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      suggestedLimitRaw: string;
      validUntil: number;
    }> = [
      {
        tokenAddress: "",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        suggestedLimitRaw: (500n * 10n ** 6n).toString(),
        validUntil: validUntil30Days,
      },
      {
        tokenAddress: "",
        tokenSymbol: "USDT",
        tokenDecimals: 6,
        suggestedLimitRaw: (500n * 10n ** 6n).toString(),
        validUntil: validUntil30Days,
      },
      {
        tokenAddress: NATIVE_ADDRESS,
        tokenSymbol: CHAIN_CONFIG.nativeSymbol,
        tokenDecimals: 18,
        suggestedLimitRaw: (50n * 10n ** 18n).toString(),
        validUntil: validUntil30Days,
      },
    ];

    if (this.portfolioUseCase) {
      const registryTokens = await this.portfolioUseCase.listTokens(chainId).catch(() => []);
      for (const t of tokens) {
        if (t.tokenAddress) continue;
        const found = registryTokens.find(
          (rt) => rt.symbol.toUpperCase() === t.tokenSymbol.toUpperCase(),
        );
        if (found) t.tokenAddress = found.address;
      }
    }

    const resolved = tokens.filter((t) => !!t.tokenAddress);

    const overrideAddress = url.searchParams.get("tokenAddress");
    const overrideAmount  = url.searchParams.get("amountRaw");
    if (overrideAddress && overrideAmount) {
      const idx = resolved.findIndex(
        (t) => t.tokenAddress.toLowerCase() === overrideAddress.toLowerCase(),
      );
      const override = {
        tokenAddress: overrideAddress,
        tokenSymbol: "",
        tokenDecimals: 18,
        suggestedLimitRaw: overrideAmount,
        validUntil: validUntil30Days,
      };
      if (idx >= 0) {
        resolved[idx]!.suggestedLimitRaw = overrideAmount;
      } else {
        resolved.push(override);
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

    let body: unknown;
    try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }

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

    const services: Record<string, boolean> = {
      auth: true,
      intent: !!this.intentUseCase,
      portfolio: !!this.portfolioUseCase,
      toolRegistration: !!this.toolRegistrationUseCase,
      sessionDelegation: !!this.sessionDelegationUseCase,
      pendingDelegation: !!this.pendingDelegationRepo,
      miniAppRequest: !!this.miniAppRequestCache,
      signingRequest: !!this.signingRequestUseCase,
      commandMapping: !!this.commandMappingUseCase,
      userProfileCache: !!this.userProfileCache,
      httpQueryTool: !!this.httpQueryToolUseCase,
      userPreferences: !!this.userPreferencesRepo,
      tokenDelegation: !!this.tokenDelegationRepo,
      userProfileDB: !!this.userProfileDB,
      telegramSession: !!this.telegramSessionRepo,
      telegramNotifier: !!this.telegramNotifier,
      yieldOptimizer: !!this.yieldOptimizerUseCase,
      loyalty: !!this.loyaltyUseCase,
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
          log.debug({ reqId, body: parsed }, "request body");
          resolve(parsed);
        } catch { reject(new Error("Invalid JSON")); }
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
