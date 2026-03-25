export interface IGmailEmailSummary {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
  messageIdHeader: string;
}

export interface IGmailDraftInput {
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
  replyToMessageId?: string;
  replyToMessageIdHeader?: string;
}

export interface IGmailService {
  searchEmails(
    userId: string,
    params: { query: string; maxResults: number },
  ): Promise<IGmailEmailSummary[]>;

  createDraft(
    userId: string,
    draft: IGmailDraftInput,
  ): Promise<{ draftId: string }>;
}
