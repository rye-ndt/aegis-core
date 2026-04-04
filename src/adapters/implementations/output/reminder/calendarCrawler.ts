import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type { ICalendarService } from "../../../../use-cases/interface/output/calendar.interface";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";

const LOOK_AHEAD_SECONDS = 24 * 3600;
const CRAWL_INTERVAL_MS = 30 * 60_000;

export class CalendarCrawler {
  private isRunning = false;

  constructor(
    private readonly calendarService: ICalendarService,
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly reminderOffsetSeconds: number,
  ) {}

  start(): void {
    this.crawl().catch((err) =>
      console.error("CalendarCrawler initial crawl error:", err),
    );
    setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.crawl()
        .catch((err) =>
          console.error("CalendarCrawler crawl error:", err),
        )
        .finally(() => {
          this.isRunning = false;
        });
    }, CRAWL_INTERVAL_MS);
  }

  private async crawl(): Promise<void> {
    const users = await this.userProfileRepo.findAll();
    await Promise.allSettled(
      users.map((user) =>
        this.crawlForUser(user.userId).catch((err) =>
          console.error(`CalendarCrawler: error for user ${user.userId}:`, err),
        ),
      ),
    );
  }

  private async crawlForUser(userId: string): Promise<void> {
    const now = newCurrentUTCEpoch();
    const windowEnd = now + LOOK_AHEAD_SECONDS;

    let events;
    try {
      events = await this.calendarService.listEvents(userId, {
        startDateTime: new Date(now * 1000).toISOString(),
        endDateTime: new Date(windowEnd * 1000).toISOString(),
        maxResults: 50,
      });
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) return;
      throw err;
    }

    for (const event of events) {
      if (!event.id) continue;

      const startEpoch = Math.floor(
        new Date(event.startDateTime).getTime() / 1000,
      );
      const fireAtEpoch = startEpoch - this.reminderOffsetSeconds;

      if (fireAtEpoch <= now) continue;

      const existing = await this.notificationRepo.findBySourceId(event.id);
      if (existing) continue;

      const startLabel = new Date(startEpoch * 1000).toUTCString();
      await this.notificationRepo.create({
        id: newUuid(),
        userId,
        title: event.summary,
        body: `Starting at ${startLabel}${
          event.location ? ` — ${event.location}` : ""
        }`,
        fireAtEpoch,
        status: "pending",
        sourceType: "calendar",
        sourceId: event.id,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
    }
  }
}

