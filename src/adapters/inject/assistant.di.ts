import Redis from "ioredis";
import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { WhisperSpeechToText } from "../implementations/output/speechToText/whisper.speechToText";
import { OpenAIOrchestrator } from "../implementations/output/llmOrchestrator/openai.llmOrchestrator";
import { CalendarReadTool } from "../implementations/output/tools/calendarRead.tool";
import { CalendarWriteTool } from "../implementations/output/tools/calendarWrite.tool";
import { GoogleCalendarService } from "../implementations/output/calendarService/google.calendarService";
import { GoogleGmailService } from "../implementations/output/gmailService/google.gmailService";
import { GmailSearchEmailsTool } from "../implementations/output/tools/gmailSearchEmails.tool";
import { GmailCreateDraftTool } from "../implementations/output/tools/gmailCreateDraft.tool";
import { RetrieveUserMemoryTool } from "../implementations/output/tools/retrieveUserMemory.tool";
import { StoreUserMemoryTool } from "../implementations/output/tools/storeUserMemory.tool";
import { ToolRegistryConcrete } from "../implementations/output/toolRegistry.concrete";
import { CachedJarvisConfigRepo } from "../implementations/output/jarvisConfig/cachedJarvisConfig.repo";
import { OpenAIEmbeddingService } from "../implementations/output/embeddingService/openai.embeddingService";
import { PineconeVectorStore } from "../implementations/output/vectorStore/pinecone.vectorStore";
import { OpenAITextGenerator } from "../implementations/output/textGenerator/openai.textGenerator";
import type { IToolRegistry } from "../../use-cases/interface/output/tool.interface";
import { DrizzleSqlDB } from "../implementations/output/sqlDB/drizzleSqlDb.adapter";

export class AssistantInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private useCase: IAssistantUseCase | null = null;

  getSqlDB(): DrizzleSqlDB {
    if (!this.sqlDB) {
      this.sqlDB = new DrizzleSqlDB({
        connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/memora",
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

      const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
      const jarvisConfigRepo = new CachedJarvisConfigRepo(sqlDB.jarvisConfig, redis);

      const embeddingService = new OpenAIEmbeddingService(apiKey);
      const vectorStore = new PineconeVectorStore(
        process.env.PINECONE_API_KEY ?? "",
        process.env.PINECONE_INDEX_NAME ?? "memora-user-memories",
        process.env.PINECONE_HOST,
      );
      const enrichmentGenerator = new OpenAITextGenerator(apiKey, "gpt-4o-mini");

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

      const registryFactory = (userId: string): IToolRegistry => {
        const r = new ToolRegistryConcrete();
        r.register(new CalendarReadTool(userId, calendarService));
        r.register(new CalendarWriteTool(userId, calendarService));
        r.register(new GmailSearchEmailsTool(userId, gmailService));
        r.register(new GmailCreateDraftTool(userId, gmailService));
        r.register(
          new RetrieveUserMemoryTool(userId, embeddingService, vectorStore, sqlDB.userMemories),
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
        return r;
      };

      this.useCase = new AssistantUseCaseImpl(
        speechToText,
        orchestrator,
        registryFactory,
        sqlDB.conversations,
        sqlDB.messages,
        jarvisConfigRepo,
        sqlDB.users,
      );
    }
    return this.useCase;
  }
}
