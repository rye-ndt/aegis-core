import { PrivyClient } from "@privy-io/server-auth";
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
    const email = (googleAccount && "email" in googleAccount ? googleAccount.email as string : undefined)
      ?? (user as unknown as { email?: string }).email
      ?? "";

    if (!email) throw new Error("PRIVY_NO_EMAIL");
    return { privyDid: claims.userId, email };
  }
}
