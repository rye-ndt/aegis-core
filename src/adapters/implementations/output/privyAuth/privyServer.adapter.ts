import { PrivyClient } from "@privy-io/server-auth";
import type { User } from "@privy-io/server-auth";
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import type { IPrivyAuthService, PrivyUserProfile } from "../../../../use-cases/interface/output/privyAuth.interface";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("privyAuth");
const PRIVY_VERIFY_CACHE_TTL_MS = Number(process.env.PRIVY_VERIFY_CACHE_TTL_MS ?? 5 * 60_000);
const PRIVY_VERIFY_CACHE_MAX = Number(process.env.PRIVY_VERIFY_CACHE_MAX ?? 5_000);

export class PrivyServerAuthAdapter implements IPrivyAuthService {
  private client: PrivyClient;
  private readonly verifyLiteCache = new LRUCache<string, { privyDid: string }>({
    max: PRIVY_VERIFY_CACHE_MAX,
    ttl: PRIVY_VERIFY_CACHE_TTL_MS,
  });

  constructor(appId: string, appSecret: string) {
    this.client = new PrivyClient(appId, appSecret);
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async verifyToken(accessToken: string): Promise<PrivyUserProfile> {
    const claims = await this.client.verifyAuthToken(accessToken);
    const user = await this.client.getUser(claims.userId);

    const googleAccount = user.linkedAccounts.find((a) => a.type === "google_oauth");
    const telegramAccount = user.linkedAccounts.find((a) => a.type === "telegram");

    const googleEmail = (googleAccount && "email" in googleAccount)
      ? (googleAccount as { email: string }).email
      : undefined;

    const telegramUserId = (telegramAccount && "telegramUserId" in telegramAccount)
      ? (telegramAccount as { telegramUserId: string }).telegramUserId
      : undefined;

    const telegramUsername = (telegramAccount && "username" in telegramAccount)
      ? (telegramAccount as { username?: string }).username
      : undefined;

    const telegramFallbackEmail = telegramUserId
      ? `tg_${telegramUserId}@privy.local`
      : undefined;

    const email = googleEmail
      ?? (user as unknown as { email?: string }).email
      ?? telegramFallbackEmail
      ?? "";

    if (!email) throw new Error("PRIVY_NO_EMAIL");

    const embeddedWallet = user.linkedAccounts.find(
      (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy",
    );

    const linkedExternalWallets = user.linkedAccounts
      .filter((a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType !== "privy")
      .map((a) => (a as { address: string }).address)
      .filter(Boolean);

    const privyCreatedAt = user.createdAt
      ? Math.floor(new Date(user.createdAt).getTime() / 1000)
      : undefined;

    return {
      privyDid: claims.userId,
      email,
      googleEmail,
      telegramUserId,
      telegramUsername,
      embeddedWalletAddress: embeddedWallet && "address" in embeddedWallet
        ? (embeddedWallet as { address: string }).address
        : undefined,
      linkedExternalWallets,
      privyCreatedAt,
    };
  }

  async verifyTokenLite(accessToken: string): Promise<{ privyDid: string }> {
    const key = this.hashToken(accessToken);
    const cached = this.verifyLiteCache.get(key);
    if (cached) return cached;
    const claims = await this.client.verifyAuthToken(accessToken);
    const result = { privyDid: claims.userId };
    this.verifyLiteCache.set(key, result);
    return result;
  }

  async getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string> {
    let user: User | null = null;

    try {
      user = await this.client.getUserByTelegramUserId(telegramUserId);
      if (user) {
        log.debug({ choice: "existing-user", telegramUserId, userId: user.id }, "found existing Privy user");
      }
    } catch (err) {
      log.error({ err, telegramUserId }, "getUserByTelegramUserId error");
    }

    if (!user) {
      log.debug({ choice: "import-user", telegramUserId }, "no existing user, importing");
      user = await this.client.importUser({
        linkedAccounts: [
          { type: "telegram", telegramUserId } as Parameters<PrivyClient["importUser"]>[0]["linkedAccounts"][0],
        ],
        createEthereumWallet: true,
      });
      log.info({ step: "user-created", telegramUserId, userId: user.id }, "created new Privy user");
    }

    const embeddedWallet = user.linkedAccounts.find(
      (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy",
    );

    if (embeddedWallet && "address" in embeddedWallet) {
      return (embeddedWallet as { address: string }).address;
    }

    log.debug({ telegramUserId }, "no embedded wallet, creating one");
    const updated = await this.client.createWallets({ userId: user.id, createEthereumWallet: true });
    const newWallet = updated.linkedAccounts.find(
      (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy",
    );

    if (!newWallet || !("address" in newWallet)) {
      throw new Error(
        `[Privy] could not provision embedded wallet for telegramUserId=${telegramUserId}. ` +
        "Ensure embedded wallet creation is enabled in your Privy dashboard.",
      );
    }

    return (newWallet as { address: string }).address;
  }
}
