import "dotenv/config";
import readline from "readline";
import Redis from "ioredis";
import { UserInject } from "./adapters/inject/user.di";
import { CachedJarvisConfigRepo } from "./adapters/implementations/output/jarvisConfig/cachedJarvisConfig.repo";
import type { IJarvisConfigDB } from "./use-cases/interface/output/repository/jarvisConfig.repo";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function readMultiline(prompt: string): Promise<string> {
  console.log(prompt);
  console.log('(Enter your text. Type "END" on a new line when done.)');
  const lines: string[] = [];
  while (true) {
    const line = await question("");
    if (line === "END") break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function handleGet(repo: IJarvisConfigDB): Promise<void> {
  const config = await repo.get();
  if (!config) {
    console.log("\nNo system prompt configured yet.");
  } else {
    console.log("\n=== Current JARVIS system prompt ===");
    console.log(config.systemPrompt);
    console.log("====================================");
  }
}

async function handleSet(repo: IJarvisConfigDB): Promise<void> {
  const prompt = await readMultiline("\nEnter new system prompt:");
  if (!prompt.trim()) {
    console.log("Aborted — prompt was empty.");
    return;
  }
  await repo.update(prompt);
  console.log("JARVIS system prompt updated. Cache invalidated.");
}

async function main(): Promise<void> {
  const userInject = new UserInject();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const repo = new CachedJarvisConfigRepo(userInject.getSqlDB().jarvisConfig, redis);

  console.log("=== JARVIS Config CLI ===");
  console.log("1) View current system prompt");
  console.log("2) Set new system prompt");
  console.log("3) Exit");

  const choice = await question("\nSelect (1-3): ");

  try {
    if (choice === "1") {
      await handleGet(repo);
    } else if (choice === "2") {
      await handleSet(repo);
    } else if (choice === "3") {
      // fall through to exit
    } else {
      console.log("Invalid choice.");
    }
  } catch (err) {
    console.error("Failed:", err);
  }

  redis.disconnect();
  rl.close();
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  rl.close();
  process.exit(1);
});
