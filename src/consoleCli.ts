import "dotenv/config";
import * as readline from "readline";
import { AssistantInject } from "./adapters/inject/assistant.di";

// For the console CLI we use a fixed dev user — override with CLI_USER_ID env var
const CLI_USER_ID = process.env.CLI_USER_ID ?? "00000000-0000-0000-0000-000000000001";

async function main(): Promise<void> {
  const inject = new AssistantInject();
  const useCase = inject.getUseCase();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('JARVIS Console — type "exit" to quit\n');

  let conversationId: string | undefined;

  const prompt = (): void => {
    rl.question("You: ", async (line) => {
      const text = line.trim();

      if (!text || text === "exit") {
        console.log("Goodbye.");
        rl.close();
        return;
      }

      try {
        const response = await useCase.chat({
          userId: CLI_USER_ID,
          conversationId,
          message: text,
        });

        // Keep the same conversationId for the whole session
        conversationId = response.conversationId;

        console.log(`\nJARVIS: ${response.reply}`);
        if (response.toolsUsed.length > 0) {
          console.log(`[tools: ${response.toolsUsed.join(", ")}]`);
        }
        console.log();
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
