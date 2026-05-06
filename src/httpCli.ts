import "dotenv/config";
process.env.PROCESS_ROLE = "http";

import { Api } from "grammy";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { createLogger } from "./helpers/observability/logger";
import { buildNotifyResolved } from "./helpers/notifyResolved";

const log = createLogger("httpCli");

(async () => {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!tgToken) {
    log.error("TELEGRAM_BOT_TOKEN is required (for outbound notifications).");
    process.exit(1);
  }

  const inject = new AssistantInject();

  const tgApi = new Api(tgToken);
  const notifyResolved = buildNotifyResolved(tgApi);

  const signingRequestUseCase = inject.getSigningRequestUseCase(notifyResolved);
  const httpServer = inject.getHttpApiServer(signingRequestUseCase);
  httpServer.start();

  log.info("HTTP API-only replica up.");

  process.on("SIGTERM", async () => {
    log.info("SIGTERM — shutting down…");
    httpServer.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    log.info("SIGINT — shutting down…");
    httpServer.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });
})();
