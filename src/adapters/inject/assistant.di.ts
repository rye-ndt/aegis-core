import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { OpenAIOrchestrator } from "../implementations/output/orchestrator/openai";
import { ToolRegistryConcrete } from "../implementations/output/toolRegistry.concrete";
import { TavilyWebSearchService } from "../implementations/output/webSearch/tavily.webSearchService";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";
import type { IToolRegistry } from "../../use-cases/interface/output/tool.interface";
import { DrizzleSqlDB } from "../implementations/output/sqlDB/drizzleSqlDb.adapter";
import { HttpApiServer } from "../implementations/input/http/httpServer";
import type { IAuthUseCase } from "../../use-cases/interface/input/auth.interface";
import { AuthUseCaseImpl } from "../../use-cases/implementations/auth.usecase";

export class AssistantInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private useCase: IAssistantUseCase | null = null;
  private _authUseCase: IAuthUseCase | null = null;

  getSqlDB(): DrizzleSqlDB {
    if (!this.sqlDB) {
      this.sqlDB = new DrizzleSqlDB({
        connectionString:
          process.env.DATABASE_URL ?? "postgres://localhost:5432/onchain-agent",
      });
    }
    return this.sqlDB;
  }

  getUseCase(): IAssistantUseCase {
    if (!this.useCase) {
      const sqlDB = this.getSqlDB();

      const orchestrator = new OpenAIOrchestrator(
        process.env.OPENAI_API_KEY ?? "",
        process.env.OPENAI_MODEL ?? "gpt-4o",
      );

      const webSearchService = new TavilyWebSearchService(
        process.env.TAVILY_API_KEY ?? "",
      );

      const registryFactory = (_userId: string): IToolRegistry => {
        const r = new ToolRegistryConcrete();
        r.register(new WebSearchTool(webSearchService));
        return r;
      };

      this.useCase = new AssistantUseCaseImpl(
        orchestrator,
        registryFactory,
        sqlDB.conversations,
        sqlDB.messages,
      );
    }
    return this.useCase;
  }

  getAuthUseCase(): IAuthUseCase {
    if (!this._authUseCase) {
      this._authUseCase = new AuthUseCaseImpl(
        this.getSqlDB().users,
        process.env.JWT_SECRET ?? "",
        process.env.JWT_EXPIRES_IN ?? "7d",
      );
    }
    return this._authUseCase;
  }

  getHttpApiServer(): HttpApiServer {
    const port = parseInt(process.env.HTTP_API_PORT ?? "4000", 10);
    return new HttpApiServer(this.getAuthUseCase(), null, port);
  }
}
