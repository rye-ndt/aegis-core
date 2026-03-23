import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IEmbeddingService } from "../../../../use-cases/interface/output/embeddingService.interface";
import type { IVectorStore } from "../../../../use-cases/interface/output/vectorStore.interface";
import type {
  IUserMemoryDB,
  UserMemory,
} from "../../../../use-cases/interface/output/repository/userMemory.repo";
import type { ITextGenerator } from "../../../../use-cases/interface/output/textGenerator.interface";

const InputSchema = z.object({
  content: z.string().describe("The memory to store, as stated by or inferred from the user"),
  category: z
    .enum(["preference", "fact", "event", "goal"])
    .optional()
    .describe("Optional category for the memory"),
});

const DEDUP_SCORE_THRESHOLD = 0.92;

export class StoreUserMemoryTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly embeddingService: IEmbeddingService,
    private readonly vectorStore: IVectorStore,
    private readonly userMemoryRepo: IUserMemoryDB,
    private readonly textGenerator: ITextGenerator,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.STORE_USER_MEMORY,
      description:
        "Persist a fact, preference, or event about the user to long-term memory. " +
        "Call this when the user shares something personal worth remembering across conversations.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { content, category } = InputSchema.parse(input);
    const now = newCurrentUTCEpoch();

    // Step 1: contextual enrichment
    const enrichedContent = await this.enrich(content);

    // Step 2: embed the enriched content
    const { vector } = await this.embeddingService.embed({ text: enrichedContent });

    // Step 3: deduplication check
    const dupes = await this.vectorStore.query(vector, 1, { userId: this.userId });
    if (dupes.length > 0 && dupes[0].score >= DEDUP_SCORE_THRESHOLD) {
      const existingMemory = await this.userMemoryRepo.findByPineconeId(dupes[0].id);
      if (existingMemory) {
        const updated: UserMemory = {
          ...existingMemory,
          content,
          enrichedContent,
          category: category ?? existingMemory.category,
          updatedAtEpoch: now,
          lastAccessedEpoch: now,
        };
        await this.userMemoryRepo.update(updated);
        await this.vectorStore.upsert({
          id: existingMemory.pineconeId,
          vector,
          metadata: { userId: this.userId, content },
        });
        return { success: true, data: "Memory updated (duplicate detected)." };
      }
    }

    // Step 4: new memory
    const pineconeId = newUuid();
    await this.vectorStore.upsert({
      id: pineconeId,
      vector,
      metadata: { userId: this.userId, content },
    });

    await this.userMemoryRepo.create({
      id: newUuid(),
      userId: this.userId,
      content,
      enrichedContent,
      category,
      pineconeId,
      createdAtEpoch: now,
      updatedAtEpoch: now,
      lastAccessedEpoch: now,
    });

    return { success: true, data: "Memory stored successfully." };
  }

  private async enrich(content: string): Promise<string> {
    const result = await this.textGenerator.generate(
      "You are a memory enrichment assistant. Rewrite the user memory into a fuller, " +
        "self-contained statement that includes implicit context. Be concise (1-2 sentences). " +
        "Output only the enriched statement, no preamble.",
      `Enrich this memory: "${content}"`,
    );
    return result || content;
  }
}
