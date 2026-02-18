export interface ISendEmailPayload {
  to: string[];
  subject: string;
  html: string;
  from?: string;
}

export interface IEmailSender {
  send(payload: ISendEmailPayload): Promise<void>;
}
