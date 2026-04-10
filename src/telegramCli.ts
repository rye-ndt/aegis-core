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

  const httpServer = inject.getHttpApiServer();
  httpServer.start();

  const tokenCrawlerJob = inject.getTokenCrawlerJob();
  tokenCrawlerJob.start();

  const handler = new TelegramAssistantHandler(
    useCase,
    inject.getAuthUseCase(),
    sqlDB.telegramSessions,
    token,
    inject.getIntentUseCase(),
    sqlDB.userProfiles,
    inject.getTokenRegistryService(),
    inject.getViemClient(),
    parseInt(process.env.CHAIN_ID ?? "43113", 10),
    inject.getIntentParser(),
    sqlDB.toolManifests,
    inject.getToolIndexService(),
  );

  const bot = new TelegramBot(token, handler);

  console.log("Onchain Agent Telegram is up and running.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    tokenCrawlerJob.stop();
    httpServer.stop();
    await bot.stop();
    process.exit(0);
  });

  bot.start();
})();
