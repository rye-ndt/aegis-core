import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IWebSearchService } from "../../../../use-cases/interface/output/webSearch.interface";

const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The search query. Be specific. Include dates or context terms if the user mentioned them " +
      "(e.g. 'Apple WWDC 2026 announcements' rather than just 'Apple')."
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(5)
    .describe("Number of results to return. Default is 5. Max is 5."),
});

export class WebSearchTool implements ITool {
  constructor(private readonly webSearchService: IWebSearchService) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.WEB_SEARCH,
      description:
        "Search the web for up-to-date information. Use this when the user asks about " +
        "current events, recent news, live prices, product releases, or anything that may " +
        "have changed since your training cutoff. Always cite source URLs in your reply.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { query, maxResults } = InputSchema.parse(input);
    const results = await this.webSearchService.search({ query, maxResults });

    if (results.length === 0) {
      return { success: true, data: "No results found for the given query." };
    }

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
      .join("\n\n");

    return { success: true, data: formatted };
  }
}
