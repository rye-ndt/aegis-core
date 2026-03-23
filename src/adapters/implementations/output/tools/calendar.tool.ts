import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

const InputSchema = z.object({
  startDate: z.string().describe("ISO 8601 start date (e.g. 2026-03-20)"),
  endDate: z.string().describe("ISO 8601 end date (e.g. 2026-03-27)"),
});

// TODO: implement using Google Calendar API, Apple Calendar, or similar
export class CalendarTool implements ITool {
  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CALENDAR_READ,
      description: "Read events from the user's calendar.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(_input: IToolInput): Promise<IToolOutput> {
    throw new Error("CalendarTool.execute() not yet implemented");
  }
}
