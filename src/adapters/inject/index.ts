import { HttpServer } from "../implementations/input/http/httpServer";
import { AssistantInject } from "./assistant.di";
import { UserInject } from "./user.di";

export class DepInject {
  private assistant: AssistantInject = new AssistantInject();
  private user: UserInject = new UserInject();
  private httpServer: HttpServer | null = null;

  getHttpServer(port: number = 3000): HttpServer {
    if (!this.httpServer) {
      this.httpServer = new HttpServer(port);
      this.httpServer.registerAssistantController(this.assistant.getCtl());
      this.httpServer.registerUserController(this.user.getCtl());
    }

    return this.httpServer;
  }
}

export const depInjectConcrete = new DepInject();
