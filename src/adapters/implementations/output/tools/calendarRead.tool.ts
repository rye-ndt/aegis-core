import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type { ICalendarService } from "../../../../use-cases/interface/output/calendarService.interface";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

const InputSchema = z.object({
  startDateTime: z.string().describe("RFC3339 start datetime, e.g. 2026-03-25T00:00:00Z"),
  endDateTime: z.string().describe("RFC3339 end datetime, e.g. 2026-03-26T00:00:00Z"),
  query: z.string().optional().describe("Optional free-text search query to filter events"),
  maxResults: z.number().optional().describe("Maximum number of events to return (default 20)"),
  calendarId: z.string().optional().describe("Calendar ID to query (default: primary)"),
});

export class CalendarReadTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly calendarService: ICalendarService,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CALENDAR_READ,
      description: "Read events from the user's Google Calendar within a date range.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { startDateTime, endDateTime, query, maxResults, calendarId } = InputSchema.parse(input);
      const events = await this.calendarService.listEvents(this.userId, {
        startDateTime,
        endDateTime,
        query,
        maxResults,
        calendarId,
      });

      if (events.length === 0) {
        return { success: true, data: "No events found in the specified range." };
      }

      const formatted = events
        .map((e, i) => {
          const time = `${e.startDateTime} → ${e.endDateTime}`;
          const loc = e.location ? ` | ${e.location}` : "";
          return `${i + 1}. [${e.id}] ${e.summary} (${time}${loc})`;
        })
        .join("\n");

      return { success: true, data: formatted };
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) {
        return {
          success: false,
          error:
            "Google Calendar is not connected. Ask the user to visit /api/auth/google/calendar to authorize access.",
        };
      }
      throw err;
    }
  }
}
