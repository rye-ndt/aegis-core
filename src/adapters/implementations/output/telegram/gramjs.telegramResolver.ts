import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("gramjsTelegramResolver");

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
      this.connectPromise = null;
      const savedSession = this.client.session.save() as unknown as string;
      log.info({ step: "connected", session: savedSession }, "MTProto connected (save session to TG_SESSION)");
    } catch (err) {
      log.error({ err }, "MTProto connection failed");
    }
  }

  async resolveHandle(username: string): Promise<string> {
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
      log.error({ err: msg, username }, "resolveHandle failed");
      throw new TelegramHandleNotFoundError(username, msg);
    }
  }
}
