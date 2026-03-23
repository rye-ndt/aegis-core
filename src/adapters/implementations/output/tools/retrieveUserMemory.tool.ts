import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IEmbeddingService } from "../../../../use-cases/interface/output/embeddingService.interface";
import type { IVectorStore } from "../../../../use-cases/interface/output/vectorStore.interface";
import type { IUserMemoryDB } from "../../../../use-cases/interface/output/repository/userMemory.repo";

const InputSchema = z.object({
  query: z.string().describe("Natural language query describing what to retrieve"),
  topK: z.number().optional().describe("Maximum number of memories to return (default 5)"),
});

export class RetrieveUserMemoryTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly embeddingService: IEmbeddingService,
    private readonly vectorStore: IVectorStore,
    private readonly userMemoryRepo: IUserMemoryDB,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.RETRIEVE_USER_MEMORY,
      description:
        "Search the user's personal memory store for relevant facts, preferences, and past events. " +
        "ALWAYS call this BEFORE asking the user for personal information (e.g. birthday, name, preferences, past events). " +
        "If the answer might be in memory, retrieve first — only ask the user if memory returns nothing relevant.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { query, topK = 5 } = InputSchema.parse(input);

    const { vector } = await this.embeddingService.embed({ text: query });
    const results = await this.vectorStore.query(vector, topK, { userId: this.userId });

    if (results.length === 0) {
      return { success: true, data: "No relevant memories found." };
    }

    // Update lastAccessedEpoch for each hit
    const now = newCurrentUTCEpoch();
    await Promise.all(
      results.map(async (r) => {
        const memory = await this.userMemoryRepo.findByPineconeId(r.id);
        if (memory) {
          await this.userMemoryRepo.updateLastAccessed(memory.id, now);
        }
      }),
    );

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.metadata["content"] ?? r.id} (score: ${r.score.toFixed(3)})`)
      .join("\n");

    return { success: true, data: formatted };
  }
}
