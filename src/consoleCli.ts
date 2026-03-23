import "dotenv/config";
import * as readline from "readline";
import Redis from "ioredis";
import { OpenAILLMProvider } from "./adapters/implementations/output/llmProvider/openai.llmProvider";
import { UserInject } from "./adapters/inject/user.di";
import { CachedJarvisConfigRepo } from "./adapters/implementations/output/jarvisConfig/cachedJarvisConfig.repo";

async function main(): Promise<void> {
  const userInject = new UserInject();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const jarvisConfigRepo = new CachedJarvisConfigRepo(
    userInject.getSqlDB().jarvisConfig,
    redis,
  );

  const config = await jarvisConfigRepo.get();
  const systemPrompt = config?.systemPrompt;

  const provider = new OpenAILLMProvider(
    process.env.OPENAI_API_KEY!,
    process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  );

  const conversationId = `console-${Date.now()}`;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('JARVIS Console — type "exit" to quit\n');

  const prompt = (): void => {
    rl.question("You: ", async (line) => {
      const text = line.trim();

      if (!text || text === "exit") {
        console.log("Goodbye.");
        redis.disconnect();
        rl.close();
        return;
      }

      try {
        const { message, contextUsagePercent } = await provider.textReply({
          prompt: text,
          conversationId,
          systemPrompt,
        });

        console.log(`\nJARVIS: ${message}`);
        console.log(`[context: ${contextUsagePercent}%]\n`);
      } catch (err) {
        console.error("Error:", err);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
