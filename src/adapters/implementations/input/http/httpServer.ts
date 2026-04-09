import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import type { IAuthUseCase } from "../../../../use-cases/interface/input/auth.interface";

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
    _unused: null,
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
