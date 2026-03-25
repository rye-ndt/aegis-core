import { IncomingMessage, ServerResponse } from "http";
import type { IAssistantUseCase } from "../../../../use-cases/interface/input/assistant.interface";
import { readJsonBody } from "./helper";

export class AssistantControllerConcrete {
  constructor(
    private readonly assistantUseCase: IAssistantUseCase,
    private readonly userId: string,
  ) {}

  async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody<{ conversationId?: string; message: string }>(req);
      const result = await this.assistantUseCase.chat({
        userId: this.userId,
        conversationId: body.conversationId,
        message: body.message,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleVoiceChat(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Voice chat not yet implemented" }));
  }

  async handleListConversations(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.assistantUseCase.listConversations({ userId: this.userId });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleGetConversation(
    _req: IncomingMessage,
    res: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    try {
      const result = await this.assistantUseCase.getConversation({
        userId: this.userId,
        conversationId,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }
}
