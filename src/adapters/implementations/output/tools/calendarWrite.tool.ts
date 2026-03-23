import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type {
  ICalendarEvent,
  ICalendarService,
} from "../../../../use-cases/interface/output/calendarService.interface";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";

const EventSchema = z.object({
  summary: z.string().optional().describe("Event title"),
  description: z.string().optional().describe("Event description"),
  location: z.string().optional().describe("Event location"),
  startDateTime: z.string().optional().describe("RFC3339 start datetime"),
  endDateTime: z.string().optional().describe("RFC3339 end datetime"),
  timeZone: z
    .string()
    .optional()
    .describe("IANA timezone, e.g. America/New_York"),
  attendees: z
    .array(z.string())
    .optional()
    .describe("Attendee email addresses"),
  reminderMinutes: z
    .number()
    .optional()
    .describe("Popup reminder minutes before event"),
});

const InputSchema = z.object({
  action: z
    .enum(["create", "update", "delete"])
    .describe("The operation to perform"),
  eventId: z
    .string()
    .optional()
    .describe("Required for update and delete actions"),
  event: EventSchema.optional().describe(
    "Event data — required for create, partial fields allowed for update",
  ),
});

export class CalendarWriteTool implements ITool {
  constructor(
    private readonly userId: string,
    private readonly calendarService: ICalendarService,
  ) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.CALENDAR_WRITE,
      description:
        "Create, update, or delete events on the user's Google Calendar. " +
        "Use action='create' to add a new event, action='update' to modify an existing one (requires eventId), " +
        "or action='delete' to remove an event (requires eventId).",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      const { action, eventId, event: eventData } = InputSchema.parse(input);

      if (action === "create") {
        if (
          !eventData?.summary ||
          !eventData?.startDateTime ||
          !eventData?.endDateTime
        ) {
          return {
            success: false,
            error:
              "create requires event.summary, event.startDateTime, and event.endDateTime",
          };
        }

        const result = await this.calendarService.createEvent(
          this.userId,
          eventData as ICalendarEvent,
        );
        return {
          success: true,
          data: `Event created. ID: ${result.id}. Link: ${result.htmlLink}`,
        };
      }

      if (action === "update") {
        if (!eventId)
          return { success: false, error: "update requires eventId" };
        if (!eventData)
          return {
            success: false,
            error: "update requires event patch fields",
          };
        await this.calendarService.updateEvent(this.userId, eventId, eventData);
        return { success: true, data: `Event ${eventId} updated.` };
      }

      if (action === "delete") {
        if (!eventId)
          return { success: false, error: "delete requires eventId" };
        await this.calendarService.deleteEvent(this.userId, eventId);
        return { success: true, data: `Event ${eventId} deleted.` };
      }

      return { success: false, error: `Unknown action: ${action}` };
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
