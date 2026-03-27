import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/bot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/handler";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  process.exit(1);
}

const inject = new AssistantInject();
const useCase = inject.getUseCase();
const sqlDB = inject.getSqlDB();
const googleOAuthService = inject.getGoogleOAuthService();

const fixedUserId = process.env.JARVIS_USER_ID ?? process.env.CLI_USER_ID;
const handler = new TelegramAssistantHandler(
  useCase,
  sqlDB.userProfiles,
  googleOAuthService,
  fixedUserId,
  token,
);
const bot = new TelegramBot(token, handler);

const oauthPort = parseInt(process.env.OAUTH_CALLBACK_PORT ?? "3000", 10);
const oauthServer = http.createServer(async (req, res) => {
  const base = `http://localhost:${oauthPort}`;
  const url = new URL(req.url ?? "/", base);

  if (url.pathname !== "/api/auth/google/calendar/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const userId = url.searchParams.get("state");

  if (!code || !userId) {
    res.writeHead(400);
    res.end("Missing code or state parameter.");
    return;
  }

  try {
    await googleOAuthService.handleCallback(code, userId);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body><h2>Authorization complete.</h2><p>Return to Telegram — you're all set.</p></body></html>",
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.writeHead(500);
    res.end("Authorization failed. The code may be expired. Try /setup again.");
  }
});

oauthServer.listen(oauthPort, () => {
  console.log(`OAuth callback server listening on port ${oauthPort}`);
});

console.log("JARVIS Telegram bot starting…");

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  oauthServer.close();
  await bot.stop();
  process.exit(0);
});

bot.start();
