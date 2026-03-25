import { gmail } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { GmailNotConnectedError } from "../../../../helpers/errors/gmailNotConnected.error";
import type {
  IGmailDraftInput,
  IGmailEmailSummary,
  IGmailService,
} from "../../../../use-cases/interface/output/mail.interface";
import type { IGoogleOAuthTokenDB } from "../../../../use-cases/interface/output/repository/googleOAuthToken.repo";

export class GoogleGmailService implements IGmailService {
  constructor(
    private readonly tokenRepo: IGoogleOAuthTokenDB,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  private async buildClient(userId: string) {
    const stored = await this.tokenRepo.findByUserId(userId);
    if (!stored) throw new GmailNotConnectedError(userId);

    const oauth2Client = new OAuth2Client(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
    oauth2Client.setCredentials({
      access_token: stored.accessToken,
      refresh_token: stored.refreshToken,
      expiry_date: stored.expiresAtEpoch * 1000,
    });

    oauth2Client.on("tokens", async (tokens) => {
      const now = newCurrentUTCEpoch();
      await this.tokenRepo.upsert({
        id: stored.id,
        userId,
        accessToken: tokens.access_token ?? stored.accessToken,
        refreshToken: tokens.refresh_token ?? stored.refreshToken,
        expiresAtEpoch: tokens.expiry_date
          ? Math.floor(tokens.expiry_date / 1000)
          : stored.expiresAtEpoch,
        scope: tokens.scope ?? stored.scope,
        updatedAtEpoch: now,
      });
    });

    return oauth2Client;
  }

  async searchEmails(
    userId: string,
    params: { query: string; maxResults: number },
  ): Promise<IGmailEmailSummary[]> {
    const auth = await this.buildClient(userId);
    const gmailClient = gmail({ version: "v1", auth });

    const listRes = await gmailClient.users.messages.list({
      userId: "me",
      q: params.query,
      maxResults: params.maxResults,
    });

    const messages = listRes.data.messages;
    if (!messages || messages.length === 0) return [];

    const summaries: IGmailEmailSummary[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;

      const msgRes = await gmailClient.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"],
      });

      const headers = msgRes.data.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value ?? "";

      const toHeader = getHeader("To");
      const toAddresses = toHeader
        ? toHeader
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      summaries.push({
        messageId: msg.id,
        threadId: msgRes.data.threadId ?? "",
        from: getHeader("From"),
        to: toAddresses,
        subject: getHeader("Subject"),
        snippet: msgRes.data.snippet ?? "",
        date: getHeader("Date"),
        messageIdHeader: getHeader("Message-ID"),
      });
    }

    return summaries;
  }

  async createDraft(
    userId: string,
    draft: IGmailDraftInput,
  ): Promise<{ draftId: string }> {
    const auth = await this.buildClient(userId);
    const gmailClient = gmail({ version: "v1", auth });

    const lines: string[] = [
      `To: ${draft.to.join(", ")}`,
      `Subject: ${draft.subject}`,
    ];

    if (draft.replyToMessageIdHeader) {
      lines.push(`In-Reply-To: ${draft.replyToMessageIdHeader}`);
      lines.push(`References: ${draft.replyToMessageIdHeader}`);
    }

    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("");
    lines.push(draft.body);

    const rawMessage = lines.join("\r\n");
    const encodedRaw = Buffer.from(rawMessage).toString("base64url");

    const res = await gmailClient.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw: encodedRaw,
          threadId: draft.threadId,
        },
      },
    });

    return { draftId: res.data.id ?? "" };
  }
}
