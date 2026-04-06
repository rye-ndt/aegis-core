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
import { NotificationRunner } from "../implementations/output/reminder/notificationRunner";
import { CalendarCrawler } from "../implementations/output/reminder/calendarCrawler";
import { DailySummaryCrawler } from "../implementations/output/reminder/dailySummaryCrawler";
import type { INotificationSender } from "../../use-cases/interface/output/notificationSender.interface";
import { AuthUseCaseImpl } from "../../use-cases/implementations/auth.usecase";
import { HttpApiServer } from "../implementations/input/http/httpServer";
import type { IAuthUseCase } from "../../use-cases/interface/input/auth.interface";

export class AssistantInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private useCase: IAssistantUseCase | null = null;
  private _googleOAuthService: GoogleOAuthService | null = null;
  private _authUseCase: IAuthUseCase | null = null;
  private _calendarService: GoogleCalendarService | null = null;
  private _textGenerator: OpenAITextGenerator | null = null;
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

  getTextGenerator(): OpenAITextGenerator {
    if (!this._textGenerator) {
      this._textGenerator = new OpenAITextGenerator(
        process.env.OPENAI_API_KEY ?? "",
        "gpt-4o-mini",
      );
    }
    return this._textGenerator;
  }

  private getCalendarService(): GoogleCalendarService {
    if (!this._calendarService) {
      const sqlDB = this.getSqlDB();
      this._calendarService = new GoogleCalendarService(
        sqlDB.googleOAuthTokens,
        process.env.GOOGLE_CLIENT_ID ?? "",
        process.env.GOOGLE_CLIENT_SECRET ?? "",
        process.env.GOOGLE_REDIRECT_URI ?? "",
      );
    }
    return this._calendarService;
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

      const calendarService = this.getCalendarService();

      const gmailService = new GoogleGmailService(
        sqlDB.googleOAuthTokens,
        process.env.GOOGLE_CLIENT_ID ?? "",
        process.env.GOOGLE_CLIENT_SECRET ?? "",
        process.env.GOOGLE_REDIRECT_URI ?? "",
      );

      const webSearchService = new TavilyWebSearchService(
        process.env.TAVILY_API_KEY ?? "",
      );

      const todoReminderOffsetSecs =
        parseInt(process.env.TODO_REMINDER_OFFSET_HOURS ?? "24", 10) * 3600;

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
        r.register(
          new CreateTodoItemTool(
            userId,
            sqlDB.todoItems,
            sqlDB.scheduledNotifications,
            todoReminderOffsetSecs,
          ),
        );
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
    return new HttpApiServer(
      this.getAuthUseCase(),
      this.getGoogleOAuthService(),
      port,
    );
  }

  getTTS(): ITextToSpeech {
    if (!this.tts) {
      this.tts = new OpenAITTS(process.env.OPENAI_API_KEY ?? "");
    }
    return this.tts;
  }

  getNotificationRunner(sender: INotificationSender): NotificationRunner {
    const pollIntervalSecs = parseInt(process.env.NOTIFICATION_POLL_INTERVAL_SECS ?? "60", 10);
    return new NotificationRunner(
      this.getSqlDB().scheduledNotifications,
      this.getSqlDB().userProfiles,
      sender,
      pollIntervalSecs * 1000,
    );
  }

  getCalendarCrawler(): CalendarCrawler {
    const offsetMins = parseInt(process.env.CALENDAR_REMINDER_OFFSET_MINS ?? "30", 10);
    const lookAheadHours = parseInt(process.env.CALENDAR_LOOK_AHEAD_HOURS ?? "24", 10);
    const crawlIntervalMins = parseInt(process.env.CALENDAR_CRAWL_INTERVAL_MINS ?? "30", 10);
    return new CalendarCrawler(
      this.getCalendarService(),
      this.getSqlDB().scheduledNotifications,
      this.getSqlDB().userProfiles,
      offsetMins * 60,
      lookAheadHours * 3600,
      crawlIntervalMins * 60_000,
    );
  }

  getDailySummaryCrawler(sender: INotificationSender): DailySummaryCrawler {
    return new DailySummaryCrawler(
      this.getCalendarService(),
      this.getSqlDB().scheduledNotifications,
      this.getSqlDB().userProfiles,
      sender,
    );
  }
}
