import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

// TODO: implement using a search API (e.g. Brave Search, Serper, Google Custom Search)
export class WebSearchTool implements ITool {
  constructor(private readonly apiKey: string) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.WEB_SEARCH,
      description: "Search the web for up-to-date information.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          numResults: {
            type: "number",
            description: "Number of results to return (default 5)",
          },
        },
        required: ["query"],
      },
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    throw new Error("WebSearchTool.execute() not yet implemented");
  }
}
