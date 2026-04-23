import "dotenv/config";
import { Api, Bot } from "grammy";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/bot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/handler";
import { CHAIN_CONFIG } from "./helpers/chainConfig";

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const inject = new AssistantInject();
  const useCase = inject.getUseCase();
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

  const handler = new TelegramAssistantHandler(
    useCase,
    inject.getAuthUseCase(),
    sqlDB.telegramSessions,
    token,
    inject.getIntentUseCase(),
    inject.getPortfolioUseCase(),
    CHAIN_CONFIG.chainId,
    sqlDB.userProfiles,
    sqlDB.pendingDelegations,
    inject.getDelegationRequestBuilder(),
    inject.getTelegramHandleResolver(),
    inject.getPrivyAuthService(),
    signingRequestUseCase,
    inject.getResolverEngine(),
    inject.getTokenDelegationRepo(),
    inject.getExecutionEstimator(),
    inject.getMiniAppRequestCache(),
    inject.getCapabilityDispatcher(),
  );

  const bot = new TelegramBot(rawBot, handler);

  console.log("Onchain Agent Telegram is up and running.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    tokenCrawlerJob.stop();
    httpServer.stop();
    await bot.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });

  bot.start();
})();
