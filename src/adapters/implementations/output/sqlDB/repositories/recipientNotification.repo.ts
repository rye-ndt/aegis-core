import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newUuid } from "../../../../../helpers/uuid";
import type {
  IRecipientNotificationRepo,
  RecipientNotificationRow,
} from "../../../../../use-cases/interface/output/repository/recipientNotification.repo.interface";
import { recipientNotifications } from "../schema";

export class DrizzleRecipientNotificationRepo implements IRecipientNotificationRepo {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(
    row: Omit<RecipientNotificationRow, "id" | "attempts" | "lastError" | "deliveredAtEpoch">,
  ): Promise<RecipientNotificationRow> {
    const id = newUuid();
    await this.db.insert(recipientNotifications).values({
      id,
      recipientTelegramUserId: row.recipientTelegramUserId,
      recipientUserId: row.recipientUserId ?? null,
      recipientChatId: row.recipientChatId ?? null,
      senderUserId: row.senderUserId,
      senderChatId: row.senderChatId,
      senderDisplayName: row.senderDisplayName ?? null,
      senderHandle: row.senderHandle ?? null,
      kind: row.kind,
      tokenSymbol: row.tokenSymbol,
      amountFormatted: row.amountFormatted,
      chainId: row.chainId,
      txHash: row.txHash ?? null,
      status: row.status,
      attempts: 0,
      lastError: null,
      createdAtEpoch: row.createdAtEpoch,
      deliveredAtEpoch: null,
    });
    return { ...row, id, attempts: 0, lastError: null, deliveredAtEpoch: null };
  }

  async findPendingForTelegramUser(
    telegramUserId: string,
    limit = 50,
  ): Promise<RecipientNotificationRow[]> {
    const rows = await this.db
      .select()
      .from(recipientNotifications)
      .where(
        and(
          eq(recipientNotifications.recipientTelegramUserId, telegramUserId),
          eq(recipientNotifications.status, "pending"),
        ),
      )
      .orderBy(asc(recipientNotifications.createdAtEpoch))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      recipientTelegramUserId: r.recipientTelegramUserId,
      recipientUserId: r.recipientUserId ?? null,
      recipientChatId: r.recipientChatId ?? null,
      senderUserId: r.senderUserId,
      senderChatId: r.senderChatId,
      senderDisplayName: r.senderDisplayName ?? null,
      senderHandle: r.senderHandle ?? null,
      kind: r.kind as "p2p_send",
      tokenSymbol: r.tokenSymbol,
      amountFormatted: r.amountFormatted,
      chainId: r.chainId,
      txHash: r.txHash ?? null,
      status: r.status as "pending" | "delivered" | "failed",
      attempts: r.attempts,
      lastError: r.lastError ?? null,
      createdAtEpoch: r.createdAtEpoch,
      deliveredAtEpoch: r.deliveredAtEpoch ?? null,
    }));
  }

  async markDelivered(
    id: string,
    deliveredAtEpoch: number,
    recipientUserId?: string,
    recipientChatId?: string,
  ): Promise<void> {
    await this.db
      .update(recipientNotifications)
      .set({
        status: "delivered",
        deliveredAtEpoch,
        ...(recipientUserId ? { recipientUserId } : {}),
        ...(recipientChatId ? { recipientChatId } : {}),
      })
      .where(eq(recipientNotifications.id, id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(recipientNotifications)
      .set({
        status: "failed",
        lastError: error,
        attempts: sql`${recipientNotifications.attempts} + 1`,
      })
      .where(eq(recipientNotifications.id, id));
  }
}
