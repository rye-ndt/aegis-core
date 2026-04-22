import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { CHAIN_CONFIG } from "../../../../helpers/chainConfig";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import type { IToolRegistrationUseCase } from "../../../../use-cases/interface/input/toolRegistration.interface";
import type { ISessionDelegationUseCase } from "../../../../use-cases/interface/input/sessionDelegation.interface";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { ISseRegistry } from "../../../../use-cases/interface/output/sse/sseRegistry.interface";
import type { ICommandMappingUseCase } from "../../../../use-cases/interface/input/commandMapping.interface";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { IHttpQueryToolUseCase } from "../../../../use-cases/interface/input/httpQueryTool.interface";
import type { IUserPreferencesDB } from "../../../../use-cases/interface/output/repository/userPreference.repo";
import type { ITokenDelegationDB } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { NewTokenDelegation } from "../../../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { ToolManifestSchema } from "../../../../use-cases/interface/output/toolManifest.types";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";

const PermissionSchema = z.object({
  tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxAmount: z.string().regex(/^\d+$/),
  validUntil: z.number().int().positive(),
});

const DelegationRecordSchema = z.object({
  publicKey: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  smartAccountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  permissions: z.array(PermissionSchema).min(1),
  grantedAt: z.number().int().positive(),
});

export class HttpApiServer {
  private server: http.Server;

  constructor(
    private readonly authUseCase: IAuthUseCase,
    private readonly port: number,
    _jwtSecret?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly portfolioUseCase?: IPortfolioUseCase,
    private readonly toolRegistrationUseCase?: IToolRegistrationUseCase,
    private readonly sessionDelegationUseCase?: ISessionDelegationUseCase,
    private readonly pendingDelegationRepo?: IPendingDelegationDB,
    private readonly sseRegistry?: ISseRegistry,
    private readonly signingRequestUseCase?: ISigningRequestUseCase,
    private readonly commandMappingUseCase?: ICommandMappingUseCase,
    private readonly userProfileCache?: IUserProfileCache,
    private readonly httpQueryToolUseCase?: IHttpQueryToolUseCase,
    private readonly userPreferencesRepo?: IUserPreferencesDB,
    private readonly tokenDelegationRepo?: ITokenDelegationDB,
    private readonly userProfileDB?: IUserProfileDB,
  ) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error("HttpApiServer unhandled error:", err);
        this.sendJson(res, 500, { error: "Internal server error" });
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const base = `http://localhost`;
    const url = new URL(req.url ?? "/", base);
    const method = req.method?.toUpperCase();

    // CORS — allow the mini app dev server and any deployed origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "POST" && url.pathname === "/auth/privy") {
      return this.handlePrivyLogin(req, res);
    }
    if (method === 'GET' && url.pathname === '/user/profile') {
      return this.handleGetUserProfile(req, res);
    }
    if (method === "GET" && url.pathname.startsWith("/intent/")) {
      return this.handleGetIntent(req, res, url);
    }
    if (method === "GET" && url.pathname === "/portfolio") {
      return this.handleGetPortfolio(req, res);
    }
    if (method === "GET" && url.pathname === "/tokens") {
      return this.handleGetTokens(req, res, url);
    }
    if (method === "POST" && url.pathname === "/tools") {
      return this.handlePostTools(req, res);
    }
    if (method === "GET" && url.pathname === "/tools") {
      return this.handleGetTools(req, res, url);
    }
    if (method === "DELETE" && url.pathname.startsWith("/tools/")) {
      return this.handleDeleteTool(req, res, url);
    }
    if (method === 'POST' && url.pathname === '/persistent') {
      return this.handlePostPersistent(req, res);
    }
    if (method === 'GET' && url.pathname === '/permissions') {
      return this.handleGetPermissions(req, res, url);
    }
    if (method === 'GET' && url.pathname === '/delegation/pending') {
      return this.handleGetPendingDelegation(req, res);
    }
    if (method === 'POST' && /^\/delegation\/[^/]+\/signed$/.test(url.pathname)) {
      const id = url.pathname.split('/')[2] ?? '';
      return this.handlePostDelegationSigned(req, res, id);
    }
    if (method === 'GET' && url.pathname === '/events') {
      return this.handleGetEvents(req, res, url);
    }
    
    if (method === 'GET' && /^\/sign-requests\/([a-zA-Z0-9-]+)$/.test(url.pathname)) {
      const match = url.pathname.match(/^\/sign-requests\/([a-zA-Z0-9-]+)$/);
      if (match) return this.handleGetSignRequest(req, res, url, match[1]);
    }
    if (method === 'POST' && url.pathname === '/sign-response') {
      return this.handlePostSignResponse(req, res);
    }
    if (method === 'POST' && url.pathname === '/command-mappings') {
      return this.handlePostCommandMapping(req, res);
    }
    if (method === 'GET' && url.pathname === '/command-mappings') {
      return this.handleGetCommandMappings(req, res);
    }
    if (method === 'DELETE' && url.pathname.startsWith('/command-mappings/')) {
      const command = decodeURIComponent(url.pathname.split('/command-mappings/')[1] ?? '');
      return this.handleDeleteCommandMapping(req, res, command);
    }
    if (method === 'POST' && url.pathname === '/http-tools') {
      return this.handlePostHttpTool(req, res);
    }
    if (method === 'GET' && url.pathname === '/http-tools') {
      return this.handleGetHttpTools(req, res);
    }
    if (method === 'DELETE' && url.pathname.startsWith('/http-tools/')) {
      const id = url.pathname.split('/http-tools/')[1]?.trim() ?? '';
      return this.handleDeleteHttpTool(req, res, id);
    }
    if (method === "GET" && url.pathname === "/preference") {
      return this.handleGetPreference(req, res);
    }
    if (method === "POST" && url.pathname === "/preference") {
      return this.handlePostPreference(req, res);
    }
    if (method === "GET" && url.pathname === "/delegation/approval-params") {
      return this.handleGetDelegationApprovalParams(req, res, url);
    }
    if (method === "POST" && url.pathname === "/delegation/grant") {
      return this.handlePostDelegationGrant(req, res);
    }
    if (method === "GET" && url.pathname === "/delegation/grant") {
      return this.handleGetDelegationGrant(req, res);
    }

    res.writeHead(404);
    res.end("Not found");
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
      const result = await this.authUseCase.loginWithPrivy({
        privyToken: parsed.data.privyToken,
        telegramChatId: parsed.data.telegramChatId,
      });
      return this.sendJson(res, 200, result);
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

  private async handleGetIntent(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.intentUseCase) return this.sendJson(res, 503, { error: "Intent service not available" });

    const intentId = url.pathname.split("/").pop() ?? "";
    if (!intentId) return this.sendJson(res, 400, { error: "Intent ID required" });

    const result = await this.intentUseCase.confirmAndExecute({ intentId, userId });
    return this.sendJson(res, 200, result);
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

  private async handlePostPersistent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.sessionDelegationUseCase) {
      return this.sendJson(res, 503, { error: 'Session delegation store not available' });
    }

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const parsed = DelegationRecordSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, {
        error: 'Invalid delegation record',
        details: parsed.error.issues,
      });
    }

    await this.sessionDelegationUseCase.save(parsed.data);
    console.log(`[Delegation] Stored record for address ${parsed.data.address}`);

    // If the request includes a valid JWT, write the SCA + EOA into user_profiles
    // so that confirmAndExecute can find the smart account address later.
    const userId = await this.extractUserId(req);
    if (userId && this.userProfileDB) {
      const now = newCurrentUTCEpoch();
      try {
        const existing = await this.userProfileDB.findByUserId(userId);
        if (!existing) {
          await this.userProfileDB.upsert({
            userId,
            smartAccountAddress: parsed.data.smartAccountAddress,
            eoaAddress: parsed.data.signerAddress,
            createdAtEpoch: now,
            updatedAtEpoch: now,
          });
        } else {
          await this.userProfileDB.update({
            userId,
            telegramChatId: existing.telegramChatId,
            smartAccountAddress: parsed.data.smartAccountAddress,
            eoaAddress: existing.eoaAddress ?? parsed.data.signerAddress,
            sessionKeyAddress: existing.sessionKeyAddress,
            sessionKeyScope: existing.sessionKeyScope,
            sessionKeyStatus: existing.sessionKeyStatus,
            sessionKeyExpiresAtEpoch: existing.sessionKeyExpiresAtEpoch,
            updatedAtEpoch: now,
          });
        }
        console.log(`[Delegation] Upserted user_profiles for userId=${userId} sca=${parsed.data.smartAccountAddress}`);
      } catch (err) {
        console.error(`[Delegation] Failed to upsert user_profiles for userId=${userId}:`, err);
      }
    }

    return this.sendJson(res, 201, { address: parsed.data.address, saved: true });
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

    // The query parameter must be a 42-char Ethereum address (0x + 40 hex).
    // The frontend should pass the session key `address` field, not the raw compressed public key.
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

  private async handleGetEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.sseRegistry) {
      this.sendJson(res, 503, { error: 'SSE service not available' });
      return;
    }

    // EventSource cannot set Authorization header — accept ?token= as fallback
    const authHeader = req.headers.authorization;
    let userId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      userId = await this.authUseCase.resolveUserId(authHeader.slice(7));
    }
    if (!userId) {
      const token = url.searchParams.get('token');
      if (token) {
        userId = await this.authUseCase.resolveUserId(token);
      }
    }

    if (!userId) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const authedUserId: string = userId;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    this.sseRegistry.connect(authedUserId, res);

    // Replay any pending signing request the user may have missed
    // (covers the case where the mini app opens after the bot already pushed the event).
    if (this.signingRequestUseCase) {
      this.signingRequestUseCase.getPendingForUser(authedUserId).then((pending) => {
        if (!pending) return;
        const now = Math.floor(Date.now() / 1000);
        if (pending.expiresAt <= now) return;
        this.sseRegistry!.push(authedUserId, {
          type: 'sign_request',
          requestId: pending.requestId,
          to: pending.to,
          value: pending.value,
          data: pending.data,
          description: pending.description,
          expiresAt: pending.expiresAt,
        });
      }).catch((err) => {
        console.error('[SSE] replay pending signing request failed:', err);
      });
    }
  }

  private async handlePostSignResponse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: 'Unauthorized' });
    if (!this.signingRequestUseCase) return this.sendJson(res, 503, { error: 'Signing service not available' });

    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const parsed = z.object({
      requestId: z.string().min(1),
      txHash: z.string().optional(),
      rejected: z.boolean().optional(),
    }).safeParse(body);

    if (!parsed.success) {
      return this.sendJson(res, 400, { error: 'Invalid body', details: parsed.error.issues });
    }

    try {
      await this.signingRequestUseCase.resolveRequest({
        requestId: parsed.data.requestId,
        userId,
        txHash: parsed.data.txHash,
        rejected: parsed.data.rejected,
      });
      return this.sendJson(res, 200, { requestId: parsed.data.requestId, resolved: true });
    } catch (err) {
      const message = toErrorMessage(err);
      if (message === 'SIGNING_REQUEST_NOT_FOUND') return this.sendJson(res, 404, { error: 'Request not found' });
      if (message === 'SIGNING_REQUEST_EXPIRED') return this.sendJson(res, 410, { error: 'Request expired' });
      if (message === 'SIGNING_REQUEST_FORBIDDEN') return this.sendJson(res, 403, { error: 'Forbidden' });
      throw err;
    }
  }

  private async handleGetSignRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, requestId: string): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: 'Unauthorized' });
    if (!this.signingRequestUseCase) return this.sendJson(res, 503, { error: 'Signing service not available' });

    try {
      const request = await this.signingRequestUseCase.getRequest(requestId, userId);
      if (!request) return this.sendJson(res, 404, { error: 'Request not found' });
      return this.sendJson(res, 200, {
        requestId: request.requestId,
        to: request.to,
        value: request.value,
        data: request.data,
        description: request.description,
        expiresAt: request.expiresAt,
        status: request.status
      });
    } catch (err) {
      this.sendJson(res, 500, { error: 'Internal error' });
    }
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
  //
  // GET  /delegation/approval-params  → build default token list + optional override
  // POST /delegation/grant            → upsertMany delegations
  // GET  /delegation/grant            → find active delegations for user

  private async handleGetDelegationApprovalParams(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const userId = await this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });

    const chainId = CHAIN_CONFIG.chainId;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const validUntil30Days = nowEpoch + 30 * 24 * 60 * 60;

    // Default token list — USDC, USDT, AVAX (native)
    const NATIVE_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const tokens: Array<{
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      suggestedLimitRaw: string;
      validUntil: number;
    }> = [
      {
        tokenAddress: "",      // resolved from DB below
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

    // Try to resolve USDC / USDT addresses from portfolio use case (token registry)
    if (this.portfolioUseCase) {
      const registryTokens = await this.portfolioUseCase.listTokens(chainId).catch(() => []);
      for (const t of tokens) {
        if (t.tokenAddress) continue; // already set (native)
        const found = registryTokens.find(
          (rt) => rt.symbol.toUpperCase() === t.tokenSymbol.toUpperCase(),
        );
        if (found) t.tokenAddress = found.address;
      }
    }

    // Remove tokens whose address could not be resolved
    const resolved = tokens.filter((t) => !!t.tokenAddress);

    // Optional re-approval override: replace or append the matching entry
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

  private async extractUserId(req: http.IncomingMessage): Promise<string | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return null;
    return this.authUseCase.resolveUserId(authHeader.slice(7));
  }

  private readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  start(): void {
    this.server.listen(this.port, () => {
      console.log(`HTTP API server listening on port ${this.port}`);
    });
  }

  stop(): void {
    this.server.close();
  }
}
