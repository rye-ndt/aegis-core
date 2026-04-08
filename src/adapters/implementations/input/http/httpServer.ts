import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";
import type { GoogleOAuthService } from "../../output/googleOAuth/googleOAuth.service";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  username: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export class HttpApiServer {
  private server: http.Server;

  constructor(
    private readonly authUseCase: IAuthUseCase,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly port: number,
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

    if (method === "POST" && url.pathname === "/auth/register") {
      return this.handleRegister(req, res);
    }
    if (method === "POST" && url.pathname === "/auth/login") {
      return this.handleLogin(req, res);
    }
    if (method === "GET" && url.pathname === "/auth/google") {
      return this.handleGoogleAuthUrl(req, res);
    }
    if (method === "GET" && url.pathname === "/api/auth/google/calendar/callback") {
      return this.handleGoogleCallback(req, res, url);
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    try {
      const result = await this.authUseCase.register(parsed.data);
      return this.sendJson(res, 201, result);
    } catch (err) {
      if (err instanceof Error && err.message === "EMAIL_TAKEN") {
        return this.sendJson(res, 409, { error: "Email already registered" });
      }
      throw err;
    }
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch {
      return this.sendJson(res, 400, { error: "Invalid JSON" });
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return this.sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    try {
      const result = await this.authUseCase.login(parsed.data);
      return this.sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_CREDENTIALS") {
        return this.sendJson(res, 401, { error: "Invalid email or password" });
      }
      throw err;
    }
  }

  private async handleGoogleAuthUrl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = this.extractBearerToken(req);
    if (!token) {
      return this.sendJson(res, 401, { error: "Missing authorization token" });
    }

    let userId: string;
    try {
      const validated = await this.authUseCase.validateToken(token);
      userId = validated.userId;
    } catch {
      return this.sendJson(res, 401, { error: "Invalid or expired token" });
    }

    const url = this.googleOAuthService.generateAuthUrl(userId);
    return this.sendJson(res, 200, { url });
  }

  private async handleGoogleCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const code = url.searchParams.get("code");
    const userId = url.searchParams.get("state");

    if (!code || !userId) {
      res.writeHead(400);
      res.end("Missing code or state parameter.");
      return;
    }

    try {
      await this.googleOAuthService.handleCallback(code, userId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><head><meta charset="utf-8"></head><body><h2>Authorization complete.</h2><p>Return to Telegram &mdash; you're all set.</p></body></html>`);
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.writeHead(500);
      res.end("Authorization failed. The code may be expired. Try again.");
    }
  }

  private extractBearerToken(req: http.IncomingMessage): string | null {
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) return null;
    return auth.slice(7);
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
