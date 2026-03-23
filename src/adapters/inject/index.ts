import { HttpServer } from "../implementations/input/http/httpServer";
import { AssistantInject } from "./assistant.di";
import { UserInject } from "./user.di";
import { GoogleCalendarAuthController } from "../implementations/input/http/googleCalendarAuth.controller";

export class DepInject {
  private assistant: AssistantInject = new AssistantInject();
  private user: UserInject = new UserInject();
  private httpServer: HttpServer | null = null;

  async runMigrations(migrationsFolder: string = "./drizzle"): Promise<void> {
    await this.user.getSqlDB().runMigrations(migrationsFolder);
  }

  getHttpServer(port: number = 3000): HttpServer {
    if (!this.httpServer) {
      const sqlDB = this.user.getSqlDB();
      const calendarAuthCtl = new GoogleCalendarAuthController(sqlDB.googleOAuthTokens);

      this.httpServer = new HttpServer(port);
      this.httpServer.registerAssistantController(this.assistant.getCtl());
      this.httpServer.registerUserController(this.user.getCtl());
      this.httpServer.registerGoogleCalendarAuthController(calendarAuthCtl);
    }

    return this.httpServer;
  }
}

export const depInjectConcrete = new DepInject();
