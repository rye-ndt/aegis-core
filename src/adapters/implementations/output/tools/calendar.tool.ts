import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

// TODO: implement using Google Calendar API, Apple Calendar, or similar
export class CalendarTool implements ITool {
  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CALENDAR_READ,
      description: "Read events from the user's calendar.",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "ISO 8601 start date (e.g. 2026-03-20)",
          },
          endDate: {
            type: "string",
            description: "ISO 8601 end date (e.g. 2026-03-27)",
          },
        },
        required: ["startDate", "endDate"],
      },
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    throw new Error("CalendarTool.execute() not yet implemented");
  }
}
