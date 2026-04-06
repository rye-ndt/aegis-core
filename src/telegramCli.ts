import "dotenv/config";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/bot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/handler";

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const inject = new AssistantInject();
  const useCase = inject.getUseCase();
  const sqlDB = inject.getSqlDB();
  const googleOAuthService = inject.getGoogleOAuthService();
  const tts = inject.getTTS();

  const httpServer = inject.getHttpApiServer();
  httpServer.start();

  const handler = new TelegramAssistantHandler(
    useCase,
    sqlDB.userProfiles,
    googleOAuthService,
    tts,
    inject.getTextGenerator(),
    inject.getAuthUseCase(),
    sqlDB.telegramSessions,
    token,
  );

  const bot = new TelegramBot(token, handler);

  const notificationRunner = inject.getNotificationRunner(bot);
  notificationRunner.start();

  inject.getCalendarCrawler().start();
  inject.getDailySummaryCrawler(bot).start();

  console.log("JARVIS Telegram is up and running.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    httpServer.stop();
    await bot.stop();
    process.exit(0);
  });

  bot.start();
})();
