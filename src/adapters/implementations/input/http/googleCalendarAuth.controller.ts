import * as crypto from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { google } from "googleapis";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import type { IGoogleOAuthTokenDB } from "../../../../use-cases/interface/output/repository/googleOAuthToken.repo";

const STATE_TTL_SECONDS = 600; // 10 minutes

/**
 * Signs a state payload with HMAC-SHA256 using the app's JWT_SECRET so the
 * callback can verify it was issued by this server (lightweight CSRF protection).
 *
 * State format (base64url): `<userId>.<timestamp>.<hmac>`
 */
function buildState(userId: string, secret: string): string {
  const ts = String(newCurrentUTCEpoch());
  const payload = `${userId}.${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

function parseState(raw: string, secret: string): { userId: string } {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split(".");
  if (parts.length !== 3) throw new Error("invalid state");

  const [userId, ts, sig] = parts as [string, string, string];
  const payload = `${userId}.${ts}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  if (sig !== expected) throw new Error("state signature mismatch");

  const age = newCurrentUTCEpoch() - Number(ts);
  if (age > STATE_TTL_SECONDS) throw new Error("state expired");

  return { userId };
}

export class GoogleCalendarAuthController {
  constructor(private readonly tokenRepo: IGoogleOAuthTokenDB) {}

  private buildOAuth2Client() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID ?? "",
      process.env.GOOGLE_CLIENT_SECRET ?? "",
      process.env.GOOGLE_REDIRECT_URI ?? "",
    );
  }

  /**
   * GET /api/auth/google/calendar
   * Generates the Google OAuth URL and redirects to Google's consent screen.
   * Uses JARVIS_USER_ID from env — no user system required for a personal assistant.
   */
  async handleInitiate(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = process.env.JARVIS_USER_ID ?? "";
    if (!userId) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "JARVIS_USER_ID env var is not set" }));
      return;
    }

    const secret = process.env.JWT_SECRET ?? "";
    const state = buildState(userId, secret);

    const oauth2Client = this.buildOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/calendar"],
      state,
    });

    res.writeHead(302, { Location: authUrl });
    res.end();
  }

  /**
   * GET /api/auth/google/calendar/callback?code=...&state=...
   * Exchanges the authorization code for tokens and stores them in the DB.
   */
  async handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "", `http://localhost`);
    const code = url.searchParams.get("code");
    const rawState = url.searchParams.get("state");

    if (!code || !rawState) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing code or state parameter" }));
      return;
    }

    let userId: string;
    try {
      const secret = process.env.JWT_SECRET ?? "";
      ({ userId } = parseState(rawState, secret));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired state" }));
      return;
    }

    const oauth2Client = this.buildOAuth2Client();
    let accessToken = "";
    let refreshToken = "";
    let expiryDate: number | null | undefined;
    let scope = "https://www.googleapis.com/auth/calendar";
    try {
      const { tokens } = await oauth2Client.getToken(code);
      accessToken = tokens.access_token ?? "";
      refreshToken = tokens.refresh_token ?? "";
      expiryDate = tokens.expiry_date;
      scope = tokens.scope ?? scope;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to exchange authorization code" }));
      return;
    }

    const now = newCurrentUTCEpoch();
    await this.tokenRepo.upsert({
      id: newUuid(),
      userId,
      accessToken,
      refreshToken,
      expiresAtEpoch: expiryDate ? Math.floor(expiryDate / 1000) : now + 3600,
      scope,
      updatedAtEpoch: now,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, message: "Calendar connected successfully" }));
  }
}
