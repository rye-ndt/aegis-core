import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { CalendarNotConnectedError } from "../../../../helpers/errors/calendarNotConnected.error";
import type { ICalendarService } from "../../../../use-cases/interface/output/calendar.interface";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

const CHECK_INTERVAL_MS = 5 * 60_000;

export class DailySummaryCrawler {
  private isRunning = false;

  constructor(
    private readonly calendarService: ICalendarService,
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly sender: INotificationSender,
    private readonly userId: string,
  ) {}

  start(): void {
    this.isRunning = true;
    this.tick()
      .catch((err) => console.error("DailySummaryCrawler initial tick error:", err))
      .finally(() => { this.isRunning = false; });
    setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.tick()
        .catch((err) =>
          console.error("DailySummaryCrawler tick error:", err),
        )
        .finally(() => {
          this.isRunning = false;
        });
    }, CHECK_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const profile = await this.userProfileRepo.findByUserId(this.userId);
    if (!profile || profile.wakeUpHour === null) return;

    const now = newCurrentUTCEpoch();
    const nowDate = new Date(now * 1000);
    const currentHourUTC = nowDate.getUTCHours();

    if (currentHourUTC !== profile.wakeUpHour) return;

    const todayKey = nowDate.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const dedupId = `daily_summary_${todayKey}`;

    const existing = await this.notificationRepo.findBySourceId(dedupId);
    if (existing) return;

    const startOfDay = new Date(`${todayKey}T00:00:00.000Z`);
    const endOfDay = new Date(`${todayKey}T23:59:59.999Z`);

    let events;
    try {
      events = await this.calendarService.listEvents(this.userId, {
        startDateTime: startOfDay.toISOString(),
        endDateTime: endOfDay.toISOString(),
        maxResults: 50,
      });
    } catch (err) {
      if (err instanceof CalendarNotConnectedError) return;
      throw err;
    }

    const lines: string[] = [`Good morning! Here's your day for ${todayKey}:`];

    if (events.length === 0) {
      lines.push("No events scheduled today.");
    } else {
      for (const event of events) {
        const startLabel = new Date(event.startDateTime).toUTCString();
        const location = event.location ? ` @ ${event.location}` : "";
        lines.push(`• ${event.summary} — ${startLabel}${location}`);
      }
    }

    await this.sender.send(lines.join("\n"));

    await this.notificationRepo.create({
      id: newUuid(),
      userId: this.userId,
      title: "Daily summary",
      body: dedupId,
      fireAtEpoch: now,
      status: "sent",
      sourceType: "daily_summary",
      sourceId: dedupId,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
  }
}

