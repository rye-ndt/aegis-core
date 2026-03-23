import "dotenv/config";
import * as readline from "readline";
import { OpenAILLMProvider } from "./adapters/implementations/output/llmProvider/openai.llmProvider";

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
      rl.close();
      return;
    }

    try {
      const { message, contextUsagePercent } = await provider.textReply({
        prompt: text,
        conversationId,
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
