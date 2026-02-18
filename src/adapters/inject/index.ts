import { HttpServer } from "../implementations/input/http/httpServer";
import { GreetingInject } from "./greeting.di";
import { ProcessInject } from "./process.di";
import { UserInject } from "./user.di";

export class DepInject {
  private greeting: GreetingInject = new GreetingInject();
  private process: ProcessInject = new ProcessInject();
  private user: UserInject = new UserInject();
  private httpServer: HttpServer | null = null;

  getHttpServer(port: number = 3000): HttpServer {
    if (!this.httpServer) {
      this.httpServer = new HttpServer(port);
      this.httpServer.registerController(this.greeting.getCtl());
      this.httpServer.registerProcessController(this.process.getCtl());
      this.httpServer.registerUserController(this.user.getCtl());
    }

    return this.httpServer;
  }
}

export const depInjectConcrete = new DepInject();
