import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";

export class GramjsTelegramResolver implements ITelegramHandleResolver {
  private client: TelegramClient;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    private readonly botToken: string,
    session: string,
  ) {
    this.client = new TelegramClient(
      new StringSession(session),
      apiId,
      apiHash,
      { connectionRetries: 3 },
    );
    this.connectPromise = this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.start({ botAuthToken: this.botToken });
      this.connected = true;
      this.connectPromise = null; // allow GC; subsequent resolveHandle calls skip the await
      const savedSession = this.client.session.save() as unknown as string;
      console.log("[GramjsTelegramResolver] connected. Session (save to TG_SESSION):", savedSession);
    } catch (err) {
      console.error("[GramjsTelegramResolver] connection failed:", err instanceof Error ? err.message : err);
    }
  }

  async resolveHandle(username: string): Promise<string> {
    // Ensure connected before resolving
    if (this.connectPromise) {
      await this.connectPromise;
    }
    if (!this.connected) {
      throw new TelegramHandleNotFoundError(username, "MTProto client not connected");
    }

    const clean = username.replace(/^@/, "");
    try {
      const result = await this.client.invoke(
        new Api.contacts.ResolveUsername({ username: clean }),
      );
      const user = result.users[0] as Api.User | undefined;
      if (!user?.id) {
        throw new TelegramHandleNotFoundError(username, "no user in response");
      }
      return user.id.toString();
    } catch (err) {
      if (err instanceof TelegramHandleNotFoundError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Common MTProto errors:
      // USERNAME_NOT_OCCUPIED — handle doesn't exist
      // USERNAME_INVALID      — invalid format
      // FLOOD_WAIT_X          — rate limit
      console.error(`[GramjsTelegramResolver] resolveHandle failed for @${username}:`, msg);
      throw new TelegramHandleNotFoundError(username, msg);
    }
  }
}
