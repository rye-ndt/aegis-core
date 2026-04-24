import "dotenv/config";
process.env.PROCESS_ROLE = "http";

import { Api } from "grammy";
import { AssistantInject } from "./adapters/inject/assistant.di";

(async () => {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!tgToken) {
    console.error("TELEGRAM_BOT_TOKEN is required (for outbound notifications).");
    process.exit(1);
  }

  const inject = new AssistantInject();

  const tgApi = new Api(tgToken);
  const notifyResolved = async (chatId: number, txHash: string | undefined, rejected: boolean): Promise<void> => {
    if (rejected) {
      await tgApi.sendMessage(chatId, "Transaction rejected in the app.");
    } else {
      await tgApi.sendMessage(chatId, `Transaction submitted.\nTx hash: \`${txHash ?? "unknown"}\``, { parse_mode: "Markdown" });
    }
  };

  const signingRequestUseCase = inject.getSigningRequestUseCase(notifyResolved);
  const httpServer = inject.getHttpApiServer(signingRequestUseCase);
  httpServer.start();

  console.log("[httpCli] HTTP API-only replica up.");

  process.on("SIGTERM", async () => {
    console.log("[httpCli] SIGTERM — shutting down…");
    httpServer.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("[httpCli] SIGINT — shutting down…");
    httpServer.stop();
    await inject.getRedis()?.quit();
    process.exit(0);
  });
})();
