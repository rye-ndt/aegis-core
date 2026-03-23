import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

const InputSchema = z.object({
  query: z.string().describe("The search query"),
  numResults: z.number().optional().describe("Number of results to return (default 5)"),
});

// TODO: implement using a search API (e.g. Brave Search, Serper, Google Custom Search)
export class WebSearchTool implements ITool {
  constructor(private readonly apiKey: string) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.WEB_SEARCH,
      description: "Search the web for up-to-date information.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    return { success: false, error: "Web search is not yet implemented." };
  }
}
