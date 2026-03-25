import { OAuth2Client } from "google-auth-library";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IGoogleOAuthTokenDB } from "../../../../use-cases/interface/output/repository/googleOAuthToken.repo";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.modify",
];

export class GoogleOAuthService {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly tokenRepo: IGoogleOAuthTokenDB,
  ) {}

  generateAuthUrl(userId: string): string {
    const client = new OAuth2Client(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
    return client.generateAuthUrl({
      access_type: "offline",
      scope: GOOGLE_SCOPES,
      state: userId,
      prompt: "consent",
    });
  }

  async handleCallback(code: string, userId: string): Promise<void> {
    const client = new OAuth2Client(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
    const { tokens } = await client.getToken(code);
    const now = newCurrentUTCEpoch();
    await this.tokenRepo.upsert({
      id: newUuid(),
      userId,
      accessToken: tokens.access_token ?? "",
      refreshToken: tokens.refresh_token ?? "",
      expiresAtEpoch: tokens.expiry_date
        ? Math.floor(tokens.expiry_date / 1000)
        : now + 3600,
      scope: tokens.scope ?? GOOGLE_SCOPES.join(" "),
      updatedAtEpoch: now,
    });
  }
}
