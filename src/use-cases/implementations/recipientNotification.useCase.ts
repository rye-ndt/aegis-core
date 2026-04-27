import { createLogger } from "../../helpers/observability/logger";
import { getChainName, getExplorerTxUrl } from "../../helpers/chainConfig";
import type { IRecipientNotificationRepo, RecipientNotificationRow } from "../interface/output/repository/recipientNotification.repo.interface";
import type { ITelegramSessionDB } from "../interface/output/repository/telegramSession.repo";

const log = createLogger("recipientNotificationUseCase");

export class RecipientNotificationUseCase {
  constructor(
    private readonly repo: IRecipientNotificationRepo,
    private readonly telegramSessions: ITelegramSessionDB,
    private readonly send: (chatId: number, text: string, opts?: object) => Promise<void>,
  ) {}

  async dispatchP2PSend(input: {
    recipientTelegramUserId: string;
    senderUserId: string;
    senderChatId: string;
    senderDisplayName: string | null;
    senderHandle: string | null;
    tokenSymbol: string;
    amountFormatted: string;
    chainId: number;
    txHash: string | null;
  }): Promise<void> {
    log.info(
      { step: "dispatch-start", recipientTelegramUserId: input.recipientTelegramUserId, tokenSymbol: input.tokenSymbol },
      "dispatching p2p send notification",
    );

    const row = await this.repo.insert({
      ...input,
      kind: "p2p_send",
      recipientUserId: null,
      recipientChatId: null,
      status: "pending",
      createdAtEpoch: Math.floor(Date.now() / 1000),
    });

    const chatId = await this.lookupChatIdByTelegramUserId(input.recipientTelegramUserId);
    if (chatId === null) {
      log.info(
        { step: "deferred", recipientTelegramUserId: input.recipientTelegramUserId, id: row.id },
        "recipient not onboarded — notification queued",
      );
      return;
    }

    await this.tryDeliver(row, chatId);
  }

  async flushPendingForTelegramUser(
    telegramUserId: string,
    chatId: number,
    recipientUserId: string,
  ): Promise<number> {
    const pending = await this.repo.findPendingForTelegramUser(telegramUserId, 50);
    if (pending.length === 0) return 0;

    log.info({ step: "flush-start", count: pending.length, telegramUserId }, "flushing pending notifications");

    if (pending.length === 1) {
      await this.tryDeliver(pending[0]!, chatId, recipientUserId);
    } else {
      const text = this.renderDigest(pending);
      try {
        await this.send(chatId, text, { parse_mode: "Markdown" });
        const now = Math.floor(Date.now() / 1000);
        for (const r of pending) {
          await this.repo.markDelivered(r.id, now, recipientUserId, String(chatId));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, telegramUserId }, "digest delivery failed");
        for (const r of pending) {
          await this.repo.markFailed(r.id, msg);
        }
      }
    }

    log.info({ step: "flush-end", telegramUserId }, "flush complete");
    return pending.length;
  }

  private async tryDeliver(
    row: RecipientNotificationRow,
    chatId: number,
    recipientUserId?: string,
  ): Promise<void> {
    const text = this.renderSingle(row);
    try {
      await this.send(chatId, text, { parse_mode: "Markdown" });
      await this.repo.markDelivered(
        row.id,
        Math.floor(Date.now() / 1000),
        recipientUserId,
        String(chatId),
      );
      log.info({ step: "delivered", id: row.id }, "recipient notified");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, id: row.id }, "delivery failed — will remain pending");
      await this.repo.markFailed(row.id, msg);
    }
  }

  private async lookupChatIdByTelegramUserId(telegramUserId: string): Promise<number | null> {
    const session = await this.telegramSessions.findByChatId(telegramUserId);
    return session ? Number(telegramUserId) : null;
  }

  private renderSingle(r: RecipientNotificationRow): string {
    const sender = r.senderHandle ? `@${r.senderHandle}` : (r.senderDisplayName ?? "someone");
    const chain = getChainName(r.chainId);
    const tx = r.txHash ? `\n[View on explorer](${getExplorerTxUrl(r.chainId, r.txHash)})` : "";
    return `💸 *${sender}* sent you *${r.amountFormatted} ${r.tokenSymbol}* on ${chain}.${tx}`;
  }

  private renderDigest(rows: RecipientNotificationRow[]): string {
    const lines = rows.map((r) => {
      const sender = r.senderHandle ? `@${r.senderHandle}` : (r.senderDisplayName ?? "someone");
      return `• ${sender} → ${r.amountFormatted} ${r.tokenSymbol} on ${getChainName(r.chainId)}`;
    });
    return `👋 Welcome back! While you were away you received:\n\n${lines.join("\n")}`;
  }
}
