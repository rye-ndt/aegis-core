import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { PRIMARY_CATEGORY } from "../../../../helpers/enums/categories.enum";
import {
  CategorizedItem,
  ICategorizer,
} from "../../../../use-cases/interface/output/categorizer.interface";
import { TextChunk } from "../../../../use-cases/interface/output/chunker.interface";
import { newUuid } from "../../../../helpers/uuid";

const primaryCategoryValues = Object.values(PRIMARY_CATEGORY) as [
  string,
  ...string[],
];

const CategorizedItemSchema = z.object({
  category: z.enum(primaryCategoryValues),
  tags: z.array(z.string()),
});

const BatchCategorizeItemSchema = z.object({
  id: z.string(),
  category: z.enum(primaryCategoryValues),
  tags: z.array(z.string()),
});

const BatchCategorizeSchema = z.object({
  items: z.array(BatchCategorizeItemSchema),
});

export interface V1CategorizerConfig {
  model: string;
  apiKey: string;
}

export class V1Categorizer implements ICategorizer {
  private readonly client: OpenAI;

  constructor(private readonly config: V1CategorizerConfig) {
    this.client = new OpenAI({ apiKey: this.config.apiKey });
  }

  async process(text: string): Promise<CategorizedItem> {
    const completion = await this.client.chat.completions.parse({
      model: this.config.model,
      messages: [
        {
          role: "system",
          content: `
            You categorize semantic text chunks. 
            Output exactly one primary category and zero or more secondary tags.
            Primary category: choose exactly one from this fixed list (no other values allowed): 
              ${Object.values(PRIMARY_CATEGORY).join(", ")}. 
              Use "other" when the text does not fit any other category.
            Secondary tags: free-form strings describing the chunk (e.g. technologies, concepts, frameworks). 
            Any string format is allowed.
            Respond only with valid JSON matching the schema.`,
        },
        { role: "user", content: text },
      ],
      response_format: zodResponseFormat(
        CategorizedItemSchema,
        "categorized_item",
      ),
    });

    const message = completion.choices[0]?.message;
    if (!message?.parsed) {
      throw new Error("Categorizer: no parsed response from model");
    }

    const parsed = message.parsed as z.infer<typeof CategorizedItemSchema>;
    return {
      chunkId: newUuid(),
      category: parsed.category as PRIMARY_CATEGORY,
      tags: parsed.tags,
    };
  }

  async batchProcess(chunks: TextChunk[]): Promise<CategorizedItem[]> {
    if (chunks.length === 0) return [];

    const chunksBlock = chunks
      .map((c) => `[id: ${c.id}]\n${c.chunkText}`)
      .join("\n\n---\n\n");

    const completion = await this.client.chat.completions.parse({
      model: this.config.model,
      messages: [
        {
          role: "system",
          content: `You categorize multiple semantic text chunks in one response. Each chunk is labeled with [id: X]. For each chunk, output one result with the same id, plus exactly one primary category and zero or more secondary tags. You must return exactly one result per chunk and copy the chunk id exactly into the "id" field so results can be matched.
Primary category: choose exactly one from this fixed list (no other values allowed): ${Object.values(PRIMARY_CATEGORY).join(", ")}. Use "other" when the text does not fit any other category.
Secondary tags: free-form strings describing the chunk (e.g. technologies, concepts, frameworks). Any string format is allowed.
Respond only with valid JSON matching the schema.`,
        },
        {
          role: "user",
          content: `Categorize each of the following ${chunks.length} chunks (each has an id; return that id in the response):\n\n${chunksBlock}`,
        },
      ],
      response_format: zodResponseFormat(
        BatchCategorizeSchema,
        "batch_categorized",
      ),
    });

    const message = completion.choices[0]?.message;
    if (!message?.parsed) {
      throw new Error("Categorizer: no parsed response from model");
    }

    const parsed = message.parsed as z.infer<typeof BatchCategorizeSchema>;
    const byId = new Map(parsed.items.map((item) => [item.id, item]));

    return chunks.map((chunk) => {
      const item = byId.get(chunk.id);
      if (!item) {
        throw new Error(
          `Categorizer: missing response for chunk id ${chunk.id}`,
        );
      }

      return {
        chunkId: chunk.id,
        category: item.category as PRIMARY_CATEGORY,
        tags: item.tags,
      };
    });
  }
}

