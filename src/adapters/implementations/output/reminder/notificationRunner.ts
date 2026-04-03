import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

export class NotificationRunner {
  private isRunning = false;

  constructor(
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly sender: INotificationSender,
    private readonly pollIntervalMs: number = 60_000,
  ) {}

  start(): void {
    setInterval(() => {
      if (this.isRunning) return;
      this.isRunning = true;
      this.tick()
        .catch((err) =>
          console.error("NotificationRunner tick error:", err),
        )
        .finally(() => {
          this.isRunning = false;
        });
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    const now = newCurrentUTCEpoch();
    const due = await this.notificationRepo.findDue(now);
    for (const notification of due) {
      try {
        await this.sender.send(
          `Reminder: ${notification.title}\n${notification.body}`,
        );
        await this.notificationRepo.markSent(notification.id, now);
      } catch (err) {
        console.error(`NotificationRunner: failed to send ${notification.id}:`, err);
        await this.notificationRepo.markFailed(notification.id, now);
      }
    }
  }
}

