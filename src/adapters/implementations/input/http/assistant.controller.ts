import { IncomingMessage, ServerResponse } from "http";
import type {
  IAssistantUseCase,
  IChatInput,
} from "../../../../use-cases/interface/input/assistant.interface";
import { readJsonBody } from "./helper";

export class AssistantControllerConcrete {
  constructor(private readonly assistantUseCase: IAssistantUseCase) {}

  async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody<IChatInput>(req);
      const result = await this.assistantUseCase.chat(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  // TODO: parse multipart/form-data to extract audio + metadata
  async handleVoiceChat(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Voice chat not yet implemented" }));
  }

  async handleListConversations(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readJsonBody<{ userId: string }>(req);
      const result = await this.assistantUseCase.listConversations({
        userId: body.userId,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleGetConversation(
    req: IncomingMessage,
    res: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    try {
      const body = await readJsonBody<{ userId: string }>(req);
      const result = await this.assistantUseCase.getConversation({
        userId: body.userId,
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
