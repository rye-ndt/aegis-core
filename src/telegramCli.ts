import "dotenv/config";
import { Api, Bot } from "grammy";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/bot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/handler";
import { createLogger } from "./helpers/observability/logger";

const log = createLogger("telegramCli");

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.error("TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const inject = new AssistantInject();
  const sqlDB = inject.getSqlDB();

  const tgApi = new Api(token);
  const notifyResolved = async (chatId: number, txHash: string | undefined, rejected: boolean): Promise<void> => {
    if (rejected) {
      await tgApi.sendMessage(chatId, 'Transaction rejected in the app.');
    } else {
      await tgApi.sendMessage(chatId, `Transaction submitted.\nTx hash: \`${txHash ?? 'unknown'}\``, { parse_mode: 'Markdown' });
    }
  };

  const rawBot = new Bot(token);
  inject.setBot(rawBot);

  const signingRequestUseCase = inject.getSigningRequestUseCase(notifyResolved);
  const httpServer = inject.getHttpApiServer(signingRequestUseCase);
  httpServer.start();

  const tokenCrawlerJob = inject.getTokenCrawlerJob();
  tokenCrawlerJob.start();

  const yieldPoolScanJob = inject.getYieldPoolScanJob();
  yieldPoolScanJob?.start();

  const userIdleScanJob = inject.getUserIdleScanJob();
  userIdleScanJob?.start();

  const yieldReportJob = inject.getYieldReportJob();
  yieldReportJob?.start();

  const dispatcher = inject.getCapabilityDispatcher();
  if (!dispatcher) {
    log.error("Capability dispatcher unavailable — bot cannot start.");
    process.exit(1);
  }

  const handler = new TelegramAssistantHandler(
    inject.getAuthUseCase(),
    sqlDB.telegramSessions,
    dispatcher,
    inject.getMiniAppRequestCache(),
  );

  const bot = new TelegramBot(rawBot, handler);

  log.info("Onchain Agent Telegram is up and running.");

  process.on("SIGINT", async () => {
    log.info("Shutting down…");
    tokenCrawlerJob.stop();
    yieldPoolScanJob?.stop();
    userIdleScanJob?.stop();
    yieldReportJob?.stop();
    httpServer.stop();
    await bot.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });

  bot.start();
})();
