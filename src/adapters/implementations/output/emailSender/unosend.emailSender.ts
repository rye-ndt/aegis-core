import axios from "axios";
import { UNOSEND_API } from "../../../../helpers/enums/unosend.enum";
import type {
  IEmailSender,
  ISendEmailPayload,
} from "../../../../use-cases/interface/output/emailSender.interface";

export interface UnosendEmailSenderConfig {
  apiKey: string;
  from: string;
}

export class UnosendEmailSender implements IEmailSender {
  constructor(private readonly config: UnosendEmailSenderConfig) {}

  async send(payload: ISendEmailPayload): Promise<void> {
    const url = `${UNOSEND_API.BASE_URL}${UNOSEND_API.EMAILS_PATH}`;

    await axios.post(
      url,
      {
        from: this.config.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
      },
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );
  }
}
