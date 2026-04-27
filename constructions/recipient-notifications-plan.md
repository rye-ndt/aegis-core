# Recipient Notifications (Path A) — Implementation Plan

> Feature: When Alice sends tokens to `@bob` via the bot, Bob receives a Telegram message from the bot (`"@alice sent you 50 USDC on Base"`). If Bob has never `/start`ed the bot, the notification is **persisted** and **flushed on his first `/start`**, so the magic moment is preserved at onboarding ("while you were away…").
>
> Scope: in-bot sends only (Path A from the feasibility discussion). External onchain transfers (Path B) are out of scope and will reuse the same dispatch table later.

---

## Why this design

The send-by-handle pipeline already carries `recipientTelegramUserId` end-to-end (`sendCapability.ts` → `resolver.interface.ts`), but **no consumer reads it**. Telegram's platform constraint is: a bot can only message a user who has `/start`ed it. Therefore:

- We can only attempt a live push to recipients with an active `telegramSessions` row.
- For everyone else, we must **store** the notification keyed by `telegramUserId` (not `userId`/`chatId`, neither of which we know yet) and replay on `/start`.

This single store + dual delivery (live or deferred) is the whole feature.

---

## Pipeline

```
Alice: "send 5 USDC to @bob"
  │
  ▼
sendCapability resolves @bob → recipientTelegramUserId, recipient address
  │
  ▼
/confirm → tx submitted → notifyResolved(senderChatId, txHash, rejected=false)
  │
  ▼
NEW: dispatchRecipientNotification({
  recipientTelegramUserId,
  senderChatId, senderHandle, senderDisplayName,
  tokenSymbol, amountFormatted, chainId, txHash,
})
  │
  ├─ Path 1 (Bob has /started): lookup chatId via telegramUserId →
  │     bot.api.sendMessage(chatId, "@alice sent you 5 USDC on Base. Tx: …")
  │     (also persist the row as delivered, for audit/history)
  │
  └─ Path 2 (Bob has not /started): persist row with status='pending'
                                    keyed by telegramUserId
  │
  ▼
Later: Bob /start  →  AuthHandler creates session  →
                      flushPendingForTelegramUserId(bob.telegramUserId, chatId)
                      → bot.api.sendMessage(...)  → mark rows 'delivered'
```

---

## Files to create

### 1. `src/adapters/implementations/output/sqlDB/schema.ts` — new table

Add after `telegramSessions`:

```ts
export const recipientNotifications = pgTable("recipient_notifications", {
  id: uuid("id").primaryKey(),
  // Recipient identity. We always know telegramUserId at send time; the
  // other two are filled in once the recipient /starts the bot.
  recipientTelegramUserId: text("recipient_telegram_user_id").notNull(),
  recipientUserId: uuid("recipient_user_id"),         // null until /start
  recipientChatId: text("recipient_chat_id"),         // null until /start

  // Sender context (for the message body — no PII beyond what Alice typed).
  senderUserId: uuid("sender_user_id").notNull(),
  senderChatId: text("sender_chat_id").notNull(),
  senderDisplayName: text("sender_display_name"),     // e.g. "alice" or "Alice S."
  senderHandle: text("sender_handle"),                // "alice" without @, if known

  // Transfer context.
  kind: text("kind").notNull(),                       // 'p2p_send' for v1
  tokenSymbol: text("token_symbol").notNull(),
  amountFormatted: text("amount_formatted").notNull(),// human string, e.g. "5"
  chainId: integer("chain_id").notNull(),
  txHash: text("tx_hash"),

  // Lifecycle.
  status: text("status").notNull(),                   // 'pending' | 'delivered' | 'failed'
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  deliveredAtEpoch: integer("delivered_at_epoch"),
}, (t) => ({
  byTelegramUser: index("recipient_notif_by_tg_user_idx")
    .on(t.recipientTelegramUserId, t.status),
  byCreatedAt: index("recipient_notif_created_at_idx").on(t.createdAtEpoch),
}));
```

Generate migration via drizzle (`pnpm drizzle-kit generate` per existing convention — never raw SQL).

### 2. `src/use-cases/interface/output/repository/recipientNotification.repo.interface.ts`

```ts
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
```

### 3. `src/adapters/implementations/output/sqlDB/repositories/recipientNotification.repo.ts`

Standard drizzle repo. Mirror `telegramSession.repo.ts` style. `findPendingForTelegramUser` filters `status='pending'` ordered by `createdAtEpoch ASC` so the digest reads chronologically.

### 4. `src/use-cases/implementations/recipientNotification.useCase.ts`

The dispatcher and flusher live here so they're reusable from the bot adapter, the http adapter, and tests.

```ts
const log = createLogger("recipientNotificationUseCase");

export class RecipientNotificationUseCase {
  constructor(
    private readonly repo: IRecipientNotificationRepo,
    private readonly telegramSessions: ITelegramSessionRepo,
    private readonly send: (chatId: number, text: string, opts?: object) => Promise<void>,
  ) {}

  /** Called immediately after a successful p2p send confirmation. */
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
    const row = await this.repo.insert({
      ...input,
      kind: "p2p_send",
      recipientUserId: null,
      recipientChatId: null,
      status: "pending",
      createdAtEpoch: Math.floor(Date.now() / 1000),
    });

    // Try live delivery: do we already know this telegramUserId's chat?
    // The mapping lives in telegramSessions where userId is the privy/aegis user.
    // The bridge: lookupChatIdByTelegramUserId — see helper below.
    const chatId = await this.lookupChatIdByTelegramUserId(input.recipientTelegramUserId);
    if (chatId === null) {
      log.info({ step: "deferred", recipientTelegramUserId: input.recipientTelegramUserId, id: row.id },
        "recipient not onboarded — notification queued");
      return;
    }

    await this.tryDeliver(row, chatId);
  }

  /** Called from the /start handler once a session is created. */
  async flushPendingForTelegramUser(telegramUserId: string, chatId: number, recipientUserId: string): Promise<number> {
    const pending = await this.repo.findPendingForTelegramUser(telegramUserId, 50);
    if (pending.length === 0) return 0;

    log.info({ step: "flush-start", count: pending.length, telegramUserId }, "flushing pending notifications");

    if (pending.length === 1) {
      await this.tryDeliver(pending[0]!, chatId, recipientUserId);
    } else {
      // Single digest message — avoids spamming N messages at once.
      const text = this.renderDigest(pending);
      try {
        await this.send(chatId, text, { parse_mode: "Markdown" });
        const now = Math.floor(Date.now() / 1000);
        for (const r of pending) await this.repo.markDelivered(r.id, now, recipientUserId, String(chatId));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg, telegramUserId }, "digest delivery failed");
        for (const r of pending) await this.repo.markFailed(r.id, msg);
      }
    }
    log.info({ step: "flush-end", telegramUserId }, "flush complete");
    return pending.length;
  }

  private async tryDeliver(row: RecipientNotificationRow, chatId: number, recipientUserId?: string): Promise<void> {
    const text = this.renderSingle(row);
    try {
      await this.send(chatId, text, { parse_mode: "Markdown" });
      await this.repo.markDelivered(row.id, Math.floor(Date.now() / 1000), recipientUserId, String(chatId));
      log.info({ step: "delivered", id: row.id }, "recipient notified");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, id: row.id }, "delivery failed — will remain pending");
      await this.repo.markFailed(row.id, msg);
    }
  }

  private async lookupChatIdByTelegramUserId(telegramUserId: string): Promise<number | null> {
    // For Telegram private chats, chatId === userId numerically. So if any
    // telegramSessions row exists where telegramChatId === telegramUserId,
    // the recipient is onboarded. This is the cheap lookup; no schema change.
    const session = await this.telegramSessions.findByChatId(telegramUserId);
    return session ? Number(telegramUserId) : null;
  }

  private renderSingle(r: RecipientNotificationRow): string {
    const sender = r.senderHandle ? `@${r.senderHandle}` : (r.senderDisplayName ?? "someone");
    const chain = chainName(r.chainId);
    const tx = r.txHash ? `\n[View on explorer](${explorerUrl(r.chainId, r.txHash)})` : "";
    return `💸 *${sender}* sent you *${r.amountFormatted} ${r.tokenSymbol}* on ${chain}.${tx}`;
  }

  private renderDigest(rows: RecipientNotificationRow[]): string {
    const lines = rows.map((r) => {
      const sender = r.senderHandle ? `@${r.senderHandle}` : (r.senderDisplayName ?? "someone");
      return `• ${sender} → ${r.amountFormatted} ${r.tokenSymbol} on ${chainName(r.chainId)}`;
    });
    return `👋 Welcome back! While you were away you received:\n\n${lines.join("\n")}`;
  }
}
```

`chainName` and `explorerUrl` come from `helpers/chainConfig.ts` (per CLAUDE.md, no inline chain logic). Add helpers there if missing.

---

## Files to modify

### A. `src/adapters/implementations/output/capabilities/sendCapability.ts`

Already populates `recipientTelegramUserId` on the resolver result (line 646). Augment the result so the executor can dispatch:

```ts
// extend ResolverResult / SendParams (resolver.interface.ts + here)
recipientTelegramUserId: state.recipientTelegramUserId ?? null,
recipientHandle: state.recipientHandle ?? null,        // NEW: keep the @bob string for display
```

When the handle is resolved (in `resolveRecipientHandle`), also store `state.recipientHandle = handle` so the dispatcher can render `@bob`.

### B. `src/use-cases/interface/output/resolver.interface.ts`

Add `recipientHandle: string | null` next to `recipientTelegramUserId`.

### C. `src/use-cases/implementations/<send executor>` (the place that finalises the send and calls `notifyResolved`)

Trace from `signingRequestUseCase` (constructed in `telegramCli.ts` / `workerCli.ts`). After tx submission succeeds (the same callsite that triggers `notifyResolved(senderChatId, txHash, false)`), call:

```ts
if (result.recipientTelegramUserId) {
  await recipientNotificationUseCase.dispatchP2PSend({
    recipientTelegramUserId: result.recipientTelegramUserId,
    senderUserId: session.userId,
    senderChatId: String(senderChatId),
    senderDisplayName: telegramFromCtx?.first_name ?? null,
    senderHandle: telegramFromCtx?.username ?? null,
    tokenSymbol: result.resolvedFrom?.symbol ?? "UNKNOWN",
    amountFormatted: result.amountFormatted,
    chainId: result.chainId,
    txHash,
  });
}
```

Best-effort — wrap in try/catch and `log.error({ err }, "recipient-notify-dispatch-failed")`. Never block the sender's success reply on notification delivery.

### D. `src/adapters/implementations/input/telegram/handler.ts` — `/start` flush

In the auth-success path (after the welcome reply, around line 134–142), call:

```ts
await this.recipientNotificationUseCase.flushPendingForTelegramUser(
  String(ctx.from!.id),
  ctx.chat!.id,
  session.userId,
);
```

Wrap in try/catch — flushing must never break the welcome flow.

### E. `src/telegramCli.ts` and `src/workerCli.ts` — wiring

Both files construct `signingRequestUseCase` with the `notifyResolved` callback. Add a parallel `recipientNotificationUseCase`:

```ts
const recipientNotify = inject.getRecipientNotificationUseCase(
  async (chatId, text, opts) => { await tgApi.sendMessage(chatId, text, opts); },
);
const signingRequestUseCase = inject.getSigningRequestUseCase(notifyResolved, recipientNotify);
```

Pass into `TelegramAssistantHandler` constructor as well so `/start` can flush.

### F. `src/adapters/inject/assistant.di.ts`

- New `getRecipientNotificationRepo()` returning the drizzle repo.
- New `getRecipientNotificationUseCase(send)` wiring repo + `sqlDB.telegramSessions` + send fn.
- Extend `getSigningRequestUseCase` signature to accept the new use case (optional param to keep call sites that don't need it working — though both CLIs do).
- Pass `recipientNotificationUseCase` into `TelegramAssistantHandler` constructor (extend signature).

---

## Edge cases & decisions

| Case | Behaviour |
|---|---|
| Recipient never `/start`s | Row stays `pending` forever. v1: no expiry. v2: add a 30-day TTL job. |
| Same recipient, many pending | `/start` shows a digest (single message), not N messages. Threshold: `>1` ⇒ digest. |
| Live delivery fails (Telegram 403, user blocked bot) | `markFailed` with the error. Do **not** retry automatically in v1. |
| Recipient onboarded but `chatId !== telegramUserId` (group chat) | We only target private chats. The `lookupChatIdByTelegramUserId` shortcut (chatId === userId) is correct for DMs. If we ever support group sends, replace with an explicit `userProfiles.telegramChatId` lookup. |
| Privy creates the recipient wallet but recipient never claims | Tokens are at the deterministic smart-account address — recoverable on first `/start`. The notification will sit pending and surface at that moment. Exactly the desired UX. |
| Sender retries the same intent | Each successful tx generates one row. Not deduped — that's correct, both transfers really happened. |
| Notification dispatch throws | Never propagates to the sender's `/confirm` response. Logged at error level; the tx still succeeds visibly. |

---

## Logging (mandatory per CLAUDE.md)

- Scope: `recipientNotificationUseCase`.
- Steps emitted: `dispatch-start`, `deferred`, `delivered`, `flush-start`, `flush-end`, plus `markFailed` on errors.
- Metadata fields: `recipientTelegramUserId`, `id` (notification id), `count` (digest size), `chainId`, `tokenSymbol`. **Never** log `txHash` at info level — keep at `debug` if needed.

---

## Privacy

- Sender display name and handle come from the sender's own Telegram metadata (`ctx.from.username`, `ctx.from.first_name`). They are already public to the recipient via the bot's own `@from` line, so storing is fine.
- Never log or persist any token, signature, or session secret in `recipientNotifications`.
- `txHash` is public on-chain; storing for the explorer link is fine.

---

## Out of scope (deliberate)

1. **Onchain external transfers** (Path B). Reuses this table later with `kind='onchain_inbound'`.
2. **Notification preferences / mute.** A future settings tab can add a "p2p notifications: on/off" flag on `userProfiles`.
3. **Localization.** All strings are English for v1.
4. **Read receipts / acknowledgement.** We don't track whether the recipient saw the message beyond Telegram's delivery ack.

---

## Status.md update

After implementation, append to `be/src/adapters/implementations/output/capabilities/status.md` (or the closest existing status doc covering p2p send):

- New table `recipient_notifications` and the dispatcher use case.
- Convention: any future "external party should know about a thing that happened to them" feature reuses `RecipientNotificationUseCase` rather than rolling its own pathway.
- New metadata field name `id` in the `recipientNotificationUseCase` log scope = the row PK.
