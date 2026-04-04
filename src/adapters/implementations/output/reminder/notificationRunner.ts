import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import type { IScheduledNotificationDB } from "../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { INotificationSender } from "../../../../use-cases/interface/output/notificationSender.interface";

export class NotificationRunner {
  private isRunning = false;

  constructor(
    private readonly notificationRepo: IScheduledNotificationDB,
    private readonly userProfileRepo: IUserProfileDB,
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
    if (due.length === 0) return;

    const uniqueUserIds = [...new Set(due.map((n) => n.userId))];
    const profiles = await Promise.all(
      uniqueUserIds.map((id) => this.userProfileRepo.findByUserId(id)),
    );
    const profileMap = new Map(uniqueUserIds.map((id, i) => [id, profiles[i]]));

    for (const notification of due) {
      const profile = profileMap.get(notification.userId);
      if (!profile?.telegramChatId) {
        await this.notificationRepo.markFailed(notification.id, now);
        continue;
      }
      try {
        await this.sender.send(
          `Reminder: ${notification.title}\n${notification.body}`,
          profile.telegramChatId,
        );
        await this.notificationRepo.markSent(notification.id, now);
      } catch (err) {
        console.error(`NotificationRunner: failed to send ${notification.id}:`, err);
        await this.notificationRepo.markFailed(notification.id, now);
      }
    }
  }
}

