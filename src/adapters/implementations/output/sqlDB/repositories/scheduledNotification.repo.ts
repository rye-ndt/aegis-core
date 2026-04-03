import { and, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IScheduledNotificationDB,
  ScheduledNotification,
} from "../../../../../use-cases/interface/output/repository/scheduledNotification.repo";
import { scheduledNotifications } from "../schema";

export class DrizzleScheduledNotificationRepo
  implements IScheduledNotificationDB
{
  constructor(private readonly db: NodePgDatabase) {}

  async create(notification: ScheduledNotification): Promise<void> {
    await this.db.insert(scheduledNotifications).values({
      id: notification.id,
      userId: notification.userId,
      title: notification.title,
      body: notification.body,
      fireAtEpoch: notification.fireAtEpoch,
      status: notification.status,
      sourceType: notification.sourceType,
      sourceId: notification.sourceId,
      createdAtEpoch: notification.createdAtEpoch,
      updatedAtEpoch: notification.updatedAtEpoch,
    });
  }

  async findDue(nowEpoch: number): Promise<ScheduledNotification[]> {
    const rows = await this.db
      .select()
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.status, "pending"),
          lte(scheduledNotifications.fireAtEpoch, nowEpoch),
        ),
      );
    return rows.map(this.toNotification);
  }

  async findBySourceId(
    sourceId: string,
  ): Promise<ScheduledNotification | null> {
    const rows = await this.db
      .select()
      .from(scheduledNotifications)
      .where(eq(scheduledNotifications.sourceId, sourceId))
      .limit(1);
    return rows.length > 0 ? this.toNotification(rows[0]) : null;
  }

  async markSent(id: string, updatedAtEpoch: number): Promise<void> {
    await this.db
      .update(scheduledNotifications)
      .set({ status: "sent", updatedAtEpoch })
      .where(eq(scheduledNotifications.id, id));
  }

  async markFailed(id: string, updatedAtEpoch: number): Promise<void> {
    await this.db
      .update(scheduledNotifications)
      .set({ status: "failed", updatedAtEpoch })
      .where(eq(scheduledNotifications.id, id));
  }

  private toNotification(
    row: typeof scheduledNotifications.$inferSelect,
  ): ScheduledNotification {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      body: row.body,
      fireAtEpoch: row.fireAtEpoch,
      status: row.status as ScheduledNotification["status"],
      sourceType: row.sourceType as ScheduledNotification["sourceType"],
      sourceId: row.sourceId,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}

