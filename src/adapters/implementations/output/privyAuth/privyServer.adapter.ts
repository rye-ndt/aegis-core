import { PrivyClient } from "@privy-io/server-auth";
import type { User } from "@privy-io/server-auth";
import type { IPrivyAuthService, PrivyVerifiedUser } from "../../../../use-cases/interface/output/privyAuth.interface";

export class PrivyServerAuthAdapter implements IPrivyAuthService {
  private client: PrivyClient;

  constructor(appId: string, appSecret: string) {
    this.client = new PrivyClient(appId, appSecret);
  }

  async verifyToken(accessToken: string): Promise<PrivyVerifiedUser> {
    const claims = await this.client.verifyAuthToken(accessToken);
    const user = await this.client.getUser(claims.userId);

    // Privy linkedAccounts is a discriminated union — only google_oauth entries carry `email`
    const googleAccount = user.linkedAccounts.find((a) => a.type === "google_oauth");
    const telegramAccount = user.linkedAccounts.find((a) => a.type === "telegram");
    const telegramFallback = telegramAccount && "telegramUserId" in telegramAccount
      ? `tg_${(telegramAccount as { telegramUserId: string }).telegramUserId}@privy.local`
      : undefined;

    const email = (googleAccount && "email" in googleAccount ? googleAccount.email as string : undefined)
      ?? (user as unknown as { email?: string }).email
      ?? telegramFallback
      ?? "";

    if (!email) throw new Error("PRIVY_NO_EMAIL");
    return { privyDid: claims.userId, email };
  }

  async getOrCreateWalletByTelegramId(telegramUserId: string): Promise<string> {
    let user: User | null = null;

    try {
      user = await this.client.getUserByTelegramUserId(telegramUserId);
      if (user) {
        console.log(`[Privy] found existing user for telegramUserId=${telegramUserId} id=${user.id}`);
      }
    } catch (err) {
      console.error(`[Privy] getUserByTelegramUserId error for telegramUserId=${telegramUserId}:`, err instanceof Error ? err.message : err);
    }

    if (!user) {
      console.log(`[Privy] no existing user for telegramUserId=${telegramUserId}, importing...`);
      user = await this.client.importUser({
        linkedAccounts: [
          { type: "telegram", telegramUserId } as Parameters<PrivyClient["importUser"]>[0]["linkedAccounts"][0],
        ],
        createEthereumWallet: true,
      });
      console.log(`[Privy] created new user for telegramUserId=${telegramUserId} id=${user.id}`);
    }

    // If the user exists but has no embedded wallet, create one
    const embeddedWallet = user.linkedAccounts.find(
      (a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType === "privy",
    );

    if (embeddedWallet && "address" in embeddedWallet) {
      return (embeddedWallet as { address: string }).address;
    }

    // No embedded wallet yet — create one
    console.log(`[Privy] no embedded wallet for telegramUserId=${telegramUserId}, creating...`);
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
