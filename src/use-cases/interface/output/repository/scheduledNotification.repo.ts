export type NotificationStatus = "pending" | "sent" | "failed";
export type NotificationSourceType = "todo" | "calendar" | "daily_summary";

export interface ScheduledNotification {
  id: string;
  userId: string;
  title: string;
  body: string;
  fireAtEpoch: number;
  status: NotificationStatus;
  sourceType: NotificationSourceType;
  sourceId: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IScheduledNotificationDB {
  create(notification: ScheduledNotification): Promise<void>;
  findDue(nowEpoch: number): Promise<ScheduledNotification[]>;
  findBySourceId(sourceId: string): Promise<ScheduledNotification | null>;
  markSent(id: string, updatedAtEpoch: number): Promise<void>;
  markFailed(id: string, updatedAtEpoch: number): Promise<void>;
}

