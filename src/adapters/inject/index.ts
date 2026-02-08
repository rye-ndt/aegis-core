import { HttpServer } from '../implementations/input/http/HttpServer';
import { GreetingInject } from './greeting';

export class DepInject {
  private greeting: GreetingInject = new GreetingInject();
  private httpServer: HttpServer | null = null;

  getHttpServer(port: number = 3000): HttpServer {
    if (!this.httpServer) {
      this.httpServer = new HttpServer(port);
      this.httpServer.registerController(this.greeting.getCtl());
    }

    return this.httpServer;
  }
}

export const depInjectConcrete = new DepInject();
