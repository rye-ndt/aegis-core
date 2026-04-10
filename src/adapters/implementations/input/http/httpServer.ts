import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { IIntentUseCase } from "../../../../use-cases/interface/input/intent.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { IToolRegistrationUseCase } from "../../../../use-cases/interface/input/toolRegistration.interface";
import { ToolManifestSchema } from "../../../../use-cases/interface/output/toolManifest.types";
import type { ViemClientAdapter } from "../../output/blockchain/viemClient";
import jwt from "jsonwebtoken";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export class HttpApiServer {
  private server: http.Server;

  constructor(
    private readonly authUseCase: IAuthUseCase,
    _unused: null,
    private readonly port: number,
    private readonly jwtSecret?: string,
    private readonly intentUseCase?: IIntentUseCase,
    private readonly userProfileDB?: IUserProfileDB,
    private readonly tokenRegistryService?: ITokenRegistryService,
    private readonly viemClient?: ViemClientAdapter,
    private readonly chainId?: number,
    private readonly toolRegistrationUseCase?: IToolRegistrationUseCase,
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
    if (!this.userProfileDB || !this.tokenRegistryService || !this.viemClient || !this.chainId) {
      return this.sendJson(res, 503, { error: "Portfolio service not available" });
    }

    const profile = await this.userProfileDB.findByUserId(userId);
    if (!profile?.smartAccountAddress) {
      return this.sendJson(res, 404, { error: "No Smart Contract Account found" });
    }

    const scaAddress = profile.smartAccountAddress as `0x${string}`;
    const tokens = await this.tokenRegistryService.listByChain(this.chainId);
    const balances: { symbol: string; address: string; balance: string }[] = [];

    for (const token of tokens) {
      let rawBalance: bigint;
      if (token.isNative) {
        rawBalance = await this.viemClient.publicClient.getBalance({ address: scaAddress });
      } else {
        rawBalance = await this.viemClient.publicClient.readContract({
          address: token.address as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [scaAddress],
        }) as bigint;
      }
      balances.push({
        symbol: token.symbol,
        address: token.address,
        balance: (Number(rawBalance) / 10 ** token.decimals).toFixed(6),
      });
    }

    return this.sendJson(res, 200, { smartAccountAddress: scaAddress, balances });
  }

  private async handleGetTokens(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.tokenRegistryService) {
      return this.sendJson(res, 503, { error: "Token registry not available" });
    }
    const chainIdStr = url.searchParams.get("chainId");
    const chainId = chainIdStr ? parseInt(chainIdStr, 10) : (this.chainId ?? 43113);
    const tokens = await this.tokenRegistryService.listByChain(chainId);
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
