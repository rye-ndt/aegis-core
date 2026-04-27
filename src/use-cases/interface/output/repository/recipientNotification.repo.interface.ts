export type RecipientNotificationStatus = "pending" | "delivered" | "failed";

export interface RecipientNotificationRow {
  id: string;
  recipientTelegramUserId: string;
  recipientUserId: string | null;
  recipientChatId: string | null;
  senderUserId: string;
  senderChatId: string;
  senderDisplayName: string | null;
  senderHandle: string | null;
  kind: "p2p_send";
  tokenSymbol: string;
  amountFormatted: string;
  chainId: number;
  txHash: string | null;
  status: RecipientNotificationStatus;
  attempts: number;
  lastError: string | null;
  createdAtEpoch: number;
  deliveredAtEpoch: number | null;
}

export interface IRecipientNotificationRepo {
  insert(row: Omit<RecipientNotificationRow, "id" | "attempts" | "lastError" | "deliveredAtEpoch">): Promise<RecipientNotificationRow>;
  findPendingForTelegramUser(telegramUserId: string, limit?: number): Promise<RecipientNotificationRow[]>;
  markDelivered(id: string, deliveredAtEpoch: number, recipientUserId?: string, recipientChatId?: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}
