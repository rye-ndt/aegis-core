import * as http from "http";
import { AssistantControllerConcrete } from "./assistant.controller";
import { UserControllerConcrete } from "./user.controller";

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params?: Record<string, string>
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * HTTP Server - Primary Adapter
 *
 * A minimal HTTP server using Node.js built-in http module.
 * No external routing libraries - just pure Node.js.
 */
export class HttpServer {
  private server: http.Server;
  private routes: Route[] = [];
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  registerAssistantController(
    assistantController: AssistantControllerConcrete
  ): void {
    this.addRoute("POST", "/api/assistant/chat", (req, res) =>
      assistantController.handleChat(req, res)
    );
    this.addRoute("POST", "/api/assistant/voice", (req, res) =>
      assistantController.handleVoiceChat(req, res)
    );
    this.addRoute("GET", "/api/assistant/conversations", (req, res) =>
      assistantController.handleListConversations(req, res)
    );
    this.addRoute(
      "GET",
      "/api/assistant/conversations/:conversationId",
      (req, res, params) =>
        assistantController.handleGetConversation(
          req,
          res,
          params?.conversationId || ""
        )
    );
  }

  registerUserController(userController: UserControllerConcrete): void {
    this.addRoute("POST", "/api/users/register", (req, res) =>
      userController.handleRegister(req, res)
    );

    this.addRoute("POST", "/api/users/login", (req, res) =>
      userController.handleLogin(req, res)
    );

    this.addRoute("POST", "/api/users/logout", (req, res) =>
      userController.handleLogout(req, res)
    );

    this.addRoute("POST", "/api/users/refresh", (req, res) =>
      userController.handleRefresh(req, res)
    );

    this.addRoute("POST", "/api/users/verify-email", (req, res) =>
      userController.handleVerifyEmail(req, res)
    );
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];

    const pattern = path.replace(/:([^/]+)/g, (_match, paramName) => {
      paramNames.push(paramName);
      return "([^/]+)";
    });

    this.routes.push({
      method,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const method = req.method || "GET";
    const url = req.url || "/";
    const pathname = url.split("?")[0];

    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = pathname.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => {
          params[name] = match[index + 1];
        });

        await route.handler(req, res, params);
        return;
      }
    }

    // 404 Not Found
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found", path: pathname }));
  }

  /**
   * Start the HTTP server
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`JARVIS running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
