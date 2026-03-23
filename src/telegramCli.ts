import "dotenv/config";
import { AssistantInject } from "./adapters/inject/assistant.di";
import { TelegramBot } from "./adapters/implementations/input/telegram/TelegramBot";
import { TelegramAssistantHandler } from "./adapters/implementations/input/telegram/assistantHandler.telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  process.exit(1);
}

const inject = new AssistantInject();
const useCase = inject.getUseCase();

const fixedUserId = process.env.JARVIS_USER_ID ?? process.env.CLI_USER_ID;
const handler = new TelegramAssistantHandler(useCase, fixedUserId);
const bot = new TelegramBot(token, handler);

console.log("JARVIS Telegram bot starting…");

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await bot.stop();
  process.exit(0);
});

bot.start();
