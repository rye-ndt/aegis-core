import Redis from "ioredis";
import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { WhisperSpeechToText } from "../implementations/output/stt/whisper.";
import { OpenAIOrchestrator } from "../implementations/output/orchestrator/openai";
import { CalendarReadTool } from "../implementations/output/tools/calendarRead";
import { CalendarWriteTool } from "../implementations/output/tools/calendarWrite";
import { GoogleCalendarService } from "../implementations/output/calendar/google";
import { GoogleGmailService } from "../implementations/output/mail/google";
import { GmailSearchEmailsTool } from "../implementations/output/tools/gmailSearchEmails";
import { GmailCreateDraftTool } from "../implementations/output/tools/gmailCreateDraft";
import { RetrieveUserMemoryTool } from "../implementations/output/tools/retrieveUserMemory";
import { StoreUserMemoryTool } from "../implementations/output/tools/storeUserMemory";
import { CreateTodoItemTool } from "../implementations/output/tools/createTodoItem";
import { RetrieveTodoItemsTool } from "../implementations/output/tools/retrieveTodoItems";
import { ToolRegistryConcrete } from "../implementations/output/toolRegistry.concrete";
import { CachedJarvisConfigRepo } from "../implementations/output/jarvisConfig/cache";
import { OpenAIEmbeddingService } from "../implementations/output/embedding/openai";
import { PineconeVectorStore } from "../implementations/output/vectorDB/pinecone";
import { OpenAITextGenerator } from "../implementations/output/textGenerator/openai";
import type { IToolRegistry } from "../../use-cases/interface/output/tool.interface";
import { DrizzleSqlDB } from "../implementations/output/sqlDB/drizzleSqlDb.adapter";
import { GoogleOAuthService } from "../implementations/output/googleOAuth/googleOAuth.service";
import { OpenAITTS } from "../implementations/output/textToSpeech/openai";
import type { ITextToSpeech } from "../../use-cases/interface/output/tts.interface";
import { TavilyWebSearchService } from "../implementations/output/webSearch/tavily.webSearchService";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";

export class AssistantInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private useCase: IAssistantUseCase | null = null;
  private _googleOAuthService: GoogleOAuthService | null = null;
  private tts: ITextToSpeech | null = null;

  getSqlDB(): DrizzleSqlDB {
    if (!this.sqlDB) {
      this.sqlDB = new DrizzleSqlDB({
        connectionString:
          process.env.DATABASE_URL ?? "postgres://localhost:5432/memora",
      });
    }
    return this.sqlDB;
  }

  getUseCase(): IAssistantUseCase {
    if (!this.useCase) {
      const apiKey = process.env.OPENAI_API_KEY ?? "";
      const sqlDB = this.getSqlDB();

      const speechToText = new WhisperSpeechToText(apiKey);
      const orchestrator = new OpenAIOrchestrator(
        apiKey,
        process.env.OPENAI_MODEL ?? "gpt-4o",
      );

      const redis = new Redis(
        process.env.REDIS_URL ?? "redis://localhost:6379",
      );
      const jarvisConfigRepo = new CachedJarvisConfigRepo(
        sqlDB.jarvisConfig,
        redis,
      );

      const embeddingService = new OpenAIEmbeddingService(apiKey);
      const vectorStore = new PineconeVectorStore(
        process.env.PINECONE_API_KEY ?? "",
        process.env.PINECONE_INDEX_NAME ?? "memora-user-memories",
        process.env.PINECONE_HOST,
      );
      const enrichmentGenerator = new OpenAITextGenerator(
        apiKey,
        "gpt-4o-mini",
      );

      const calendarService = new GoogleCalendarService(
        sqlDB.googleOAuthTokens,
        process.env.GOOGLE_CLIENT_ID ?? "",
        process.env.GOOGLE_CLIENT_SECRET ?? "",
        process.env.GOOGLE_REDIRECT_URI ?? "",
      );

      const gmailService = new GoogleGmailService(
        sqlDB.googleOAuthTokens,
        process.env.GOOGLE_CLIENT_ID ?? "",
        process.env.GOOGLE_CLIENT_SECRET ?? "",
        process.env.GOOGLE_REDIRECT_URI ?? "",
      );

      const webSearchService = new TavilyWebSearchService(
        process.env.TAVILY_API_KEY ?? "",
      );

      const registryFactory = (userId: string): IToolRegistry => {
        const r = new ToolRegistryConcrete();
        r.register(new CalendarReadTool(userId, calendarService));
        r.register(new CalendarWriteTool(userId, calendarService));
        r.register(new GmailSearchEmailsTool(userId, gmailService));
        r.register(new GmailCreateDraftTool(userId, gmailService));
        r.register(
          new RetrieveUserMemoryTool(
            userId,
            embeddingService,
            vectorStore,
            sqlDB.userMemories,
          ),
        );
        r.register(
          new StoreUserMemoryTool(
            userId,
            embeddingService,
            vectorStore,
            sqlDB.userMemories,
            enrichmentGenerator,
          ),
        );
        r.register(new CreateTodoItemTool(userId, sqlDB.todoItems));
        r.register(new RetrieveTodoItemsTool(userId, sqlDB.todoItems));
        r.register(new WebSearchTool(webSearchService));
        return r;
      };

      this._googleOAuthService = new GoogleOAuthService(
        process.env.GOOGLE_CLIENT_ID ?? "",
        process.env.GOOGLE_CLIENT_SECRET ?? "",
        process.env.GOOGLE_REDIRECT_URI ?? "",
        sqlDB.googleOAuthTokens,
      );

      this.useCase = new AssistantUseCaseImpl(
        speechToText,
        orchestrator,
        registryFactory,
        sqlDB.conversations,
        sqlDB.messages,
        jarvisConfigRepo,
        sqlDB.userProfiles,
        embeddingService,
        vectorStore,
        enrichmentGenerator,
        sqlDB.evaluationLogs,
        sqlDB.userMemories,
      );
    }
    return this.useCase;
  }

  getGoogleOAuthService(): GoogleOAuthService {
    if (!this._googleOAuthService) this.getUseCase();
    return this._googleOAuthService!;
  }

  getTTS(): ITextToSpeech {
    if (!this.tts) {
      this.tts = new OpenAITTS(process.env.OPENAI_API_KEY ?? "");
    }
    return this.tts;
  }
}
