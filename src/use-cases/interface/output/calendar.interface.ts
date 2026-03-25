export interface ICalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  /** RFC3339, e.g. "2026-03-25T09:00:00" */
  startDateTime: string;
  endDateTime: string;
  /** IANA timezone, e.g. "America/New_York" */
  timeZone?: string;
  /** Attendee email addresses */
  attendees?: string[];
  reminderMinutes?: number;
}

export interface ICalendarService {
  listEvents(
    userId: string,
    params: {
      startDateTime: string;
      endDateTime: string;
      query?: string;
      maxResults?: number;
      calendarId?: string;
    },
  ): Promise<ICalendarEvent[]>;

  createEvent(userId: string, event: ICalendarEvent): Promise<{ id: string; htmlLink: string }>;

  updateEvent(userId: string, eventId: string, patch: Partial<ICalendarEvent>): Promise<void>;

  deleteEvent(userId: string, eventId: string, calendarId?: string): Promise<void>;
}
