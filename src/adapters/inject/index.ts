import { HttpServer } from "../implementations/input/http/httpServer";
import { AssistantInject } from "./assistant.di";
import { GoogleCalendarAuthController } from "../implementations/input/http/googleCalendarAuth.controller";

export class DepInject {
  private assistant: AssistantInject = new AssistantInject();
  private httpServer: HttpServer | null = null;

  async runMigrations(migrationsFolder: string = "./drizzle"): Promise<void> {
    await this.assistant.getSqlDB().runMigrations(migrationsFolder);
  }

  getHttpServer(port: number = 3000): HttpServer {
    if (!this.httpServer) {
      const sqlDB = this.assistant.getSqlDB();
      const calendarAuthCtl = new GoogleCalendarAuthController(sqlDB.googleOAuthTokens);

      this.httpServer = new HttpServer(port);
      this.httpServer.registerAssistantController(this.assistant.getCtl());
      this.httpServer.registerGoogleCalendarAuthController(calendarAuthCtl);
    }

    return this.httpServer;
  }
}

export const depInjectConcrete = new DepInject();
