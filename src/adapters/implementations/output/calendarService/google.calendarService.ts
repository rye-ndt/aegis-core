import { google, type calendar_v3 } from "googleapis";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type { ICalendarEvent, ICalendarService } from "../../../../use-cases/interface/output/calendarService.interface";
import type { IGoogleOAuthTokenDB } from "../../../../use-cases/interface/output/repository/googleOAuthToken.repo";

export class GoogleCalendarService implements ICalendarService {
  constructor(
    private readonly tokenRepo: IGoogleOAuthTokenDB,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  // ─── private helpers ────────────────────────────────────────────────────────

  private async buildClient(userId: string) {
    const stored = await this.tokenRepo.findByUserId(userId);
    if (!stored) throw new CalendarNotConnectedError(userId);

    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    oauth2Client.setCredentials({
      access_token: stored.accessToken,
      refresh_token: stored.refreshToken,
      expiry_date: stored.expiresAtEpoch * 1000, // googleapis uses milliseconds
    });

    // Persist silently-refreshed tokens back to DB
    oauth2Client.on("tokens", async (tokens) => {
      const now = newCurrentUTCEpoch();
      await this.tokenRepo.upsert({
        id: stored.id,
        userId,
        accessToken: tokens.access_token ?? stored.accessToken,
        refreshToken: tokens.refresh_token ?? stored.refreshToken,
        expiresAtEpoch: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : stored.expiresAtEpoch,
        scope: tokens.scope ?? stored.scope,
        updatedAtEpoch: now,
      });
    });

    return oauth2Client;
  }

  private toApiEvent(event: ICalendarEvent): calendar_v3.Schema$Event {
    const resource: calendar_v3.Schema$Event = {
      summary: event.summary,
      start: { dateTime: event.startDateTime, timeZone: event.timeZone ?? "UTC" },
      end: { dateTime: event.endDateTime, timeZone: event.timeZone ?? "UTC" },
    };
    if (event.description) resource.description = event.description;
    if (event.location) resource.location = event.location;
    if (event.attendees?.length) {
      resource.attendees = event.attendees.map((email) => ({ email }));
    }
    if (event.reminderMinutes !== undefined) {
      resource.reminders = {
        useDefault: false,
        overrides: [{ method: "popup", minutes: event.reminderMinutes }],
      };
    }
    return resource;
  }

  private fromApiEvent(item: calendar_v3.Schema$Event): ICalendarEvent {
    return {
      id: item.id ?? undefined,
      summary: item.summary ?? "(no title)",
      description: item.description ?? undefined,
      location: item.location ?? undefined,
      startDateTime: item.start?.dateTime ?? item.start?.date ?? "",
      endDateTime: item.end?.dateTime ?? item.end?.date ?? "",
      timeZone: item.start?.timeZone ?? undefined,
      attendees: item.attendees?.map((a) => a.email ?? "").filter(Boolean),
    };
  }

  // ─── ICalendarService ────────────────────────────────────────────────────────

  async listEvents(
    userId: string,
    params: {
      startDateTime: string;
      endDateTime: string;
      query?: string;
      maxResults?: number;
      calendarId?: string;
    },
  ): Promise<ICalendarEvent[]> {
    const auth = await this.buildClient(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.list({
      calendarId: params.calendarId ?? "primary",
      timeMin: params.startDateTime,
      timeMax: params.endDateTime,
      q: params.query,
      maxResults: params.maxResults ?? 20,
      singleEvents: true,
      orderBy: "startTime",
    });

    return (response.data.items ?? []).map((item) => this.fromApiEvent(item));
  }

  async createEvent(userId: string, event: ICalendarEvent): Promise<{ id: string; htmlLink: string }> {
    const auth = await this.buildClient(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: this.toApiEvent(event),
    });

    return {
      id: response.data.id ?? newUuid(),
      htmlLink: response.data.htmlLink ?? "",
    };
  }

  async updateEvent(userId: string, eventId: string, patch: Partial<ICalendarEvent>): Promise<void> {
    const auth = await this.buildClient(userId);
    const calendar = google.calendar({ version: "v3", auth });

    const patchBody: calendar_v3.Schema$Event = {};
    if (patch.summary !== undefined) patchBody.summary = patch.summary;
    if (patch.description !== undefined) patchBody.description = patch.description;
    if (patch.location !== undefined) patchBody.location = patch.location;
    if (patch.startDateTime !== undefined) {
      patchBody.start = { dateTime: patch.startDateTime, timeZone: patch.timeZone ?? "UTC" };
    }
    if (patch.endDateTime !== undefined) {
      patchBody.end = { dateTime: patch.endDateTime, timeZone: patch.timeZone ?? "UTC" };
    }
    if (patch.attendees !== undefined) {
      patchBody.attendees = patch.attendees.map((email) => ({ email }));
    }

    await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: patchBody,
    });
  }

  async deleteEvent(userId: string, eventId: string, calendarId = "primary"): Promise<void> {
    const auth = await this.buildClient(userId);
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({ calendarId, eventId });
  }
}
