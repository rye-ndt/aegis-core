import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IPortfolioUseCase } from "../../../../use-cases/interface/input/portfolio.interface";
import type { IToolRegistrationUseCase } from "../../../../use-cases/interface/input/toolRegistration.interface";
import type { ISessionDelegationUseCase } from "../../../../use-cases/interface/input/sessionDelegation.interface";
import type { IPendingDelegationDB } from "../../../../use-cases/interface/output/repository/pendingDelegation.repo";
import { ToolManifestSchema } from "../../../../use-cases/interface/output/toolManifest.types";
import jwt from "jsonwebtoken";
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
    _unused: null,
    private readonly port: number,
    private readonly jwtSecret?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly portfolioUseCase?: IPortfolioUseCase,
    private readonly toolRegistrationUseCase?: IToolRegistrationUseCase,
    private readonly sessionDelegationUseCase?: ISessionDelegationUseCase,
    private readonly pendingDelegationRepo?: IPendingDelegationDB,
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "POST" && url.pathname === "/auth/privy") {
      return this.handlePrivyLogin(req, res);
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

    const parsed = z.object({ privyToken: z.string().min(1) }).safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: "privyToken is required" });
    }

    try {
      const result = await this.authUseCase.loginWithPrivy({ privyToken: parsed.data.privyToken });
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

  private async handleGetIntent(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const userId = this.extractUserId(req);
    if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
    if (!this.intentUseCase) return this.sendJson(res, 503, { error: "Intent service not available" });

    const intentId = url.pathname.split("/").pop() ?? "";
    if (!intentId) return this.sendJson(res, 400, { error: "Intent ID required" });

    const result = await this.intentUseCase.confirmAndExecute({ intentId, userId });
    return this.sendJson(res, 200, result);
  }

  private async handleGetPortfolio(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const userId = this.extractUserId(req);
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
    const chainId = chainIdStr ? parseInt(chainIdStr, 10) : parseInt(process.env.CHAIN_ID ?? "43113", 10);
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
    const userId = this.extractUserId(req);
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
    const userId = this.extractUserId(req);
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
    const userId = this.extractUserId(req);
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

  private extractUserId(req: http.IncomingMessage): string | null {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || !this.jwtSecret) return null;
    try {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, this.jwtSecret) as { userId: string };
      return payload.userId;
    } catch {
      return null;
    }
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
