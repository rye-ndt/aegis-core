import Redis from "ioredis";
import { AssistantControllerConcrete } from "../implementations/input/http/assistant.controller";
import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { WhisperSpeechToText } from "../implementations/output/speechToText/whisper.speechToText";
import { OpenAIOrchestrator } from "../implementations/output/llmOrchestrator/openai.llmOrchestrator";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";
import { SendEmailTool } from "../implementations/output/tools/sendEmail.tool";
import { CalendarReadTool } from "../implementations/output/tools/calendarRead.tool";
import { CalendarWriteTool } from "../implementations/output/tools/calendarWrite.tool";
import { GoogleCalendarService } from "../implementations/output/calendarService/google.calendarService";
import { RetrieveUserMemoryTool } from "../implementations/output/tools/retrieveUserMemory.tool";
import { StoreUserMemoryTool } from "../implementations/output/tools/storeUserMemory.tool";
import { ToolRegistryConcrete } from "../implementations/output/toolRegistry.concrete";
import { CachedJarvisConfigRepo } from "../implementations/output/jarvisConfig/cachedJarvisConfig.repo";
import { OpenAIEmbeddingService } from "../implementations/output/embeddingService/openai.embeddingService";
import { PineconeVectorStore } from "../implementations/output/vectorStore/pinecone.vectorStore";
import { OpenAITextGenerator } from "../implementations/output/textGenerator/openai.textGenerator";
import type { IToolRegistry } from "../../use-cases/interface/output/tool.interface";
import { UserInject } from "./user.di";

export class AssistantInject {
  private useCase: IAssistantUseCase | null = null;
  private ctl: AssistantControllerConcrete | null = null;
  private userInject: UserInject = new UserInject();

  getUseCase(): IAssistantUseCase {
    if (!this.useCase) {
      const apiKey = process.env.OPENAI_API_KEY ?? "";

      const speechToText = new WhisperSpeechToText(apiKey);
      const orchestrator = new OpenAIOrchestrator(
        apiKey,
        process.env.OPENAI_MODEL ?? "gpt-4o",
      );

      const sqlDB = this.userInject.getSqlDB();
      const redis = new Redis(
        process.env.REDIS_URL ?? "redis://localhost:6379",
      );
      const jarvisConfigRepo = new CachedJarvisConfigRepo(
        sqlDB.jarvisConfig,
        redis,
      );

      // Singletons for RAG
      const embeddingService = new OpenAIEmbeddingService(apiKey);
      const vectorStore = new PineconeVectorStore(
        process.env.PINECONE_API_KEY ?? "",
        process.env.PINECONE_INDEX_NAME ?? "memora-user-memories",
        process.env.PINECONE_HOST,
      );
      const userMemoryRepo = sqlDB.userMemories;
      const enrichmentGenerator = new OpenAITextGenerator(
        apiKey,
        "gpt-4o-mini",
      );
      const emailSender = this.userInject.getEmailSender();

      // Singleton calendar service — token repo resolved once, userId injected per-request
      const calendarService = new GoogleCalendarService(
        sqlDB.googleOAuthTokens,
        process.env.GOOGLE_CLIENT_ID ?? "",
        process.env.GOOGLE_CLIENT_SECRET ?? "",
        process.env.GOOGLE_REDIRECT_URI ?? "",
      );

      // Per-request registry factory — captures singletons via closure, injects userId at call time
      const registryFactory = (userId: string): IToolRegistry => {
        const r = new ToolRegistryConcrete();
        r.register(new WebSearchTool(process.env.WEB_SEARCH_API_KEY ?? ""));
        r.register(new SendEmailTool(emailSender));
        r.register(new CalendarReadTool(userId, calendarService));
        r.register(new CalendarWriteTool(userId, calendarService));
        r.register(
          new RetrieveUserMemoryTool(
            userId,
            embeddingService,
            vectorStore,
            userMemoryRepo,
          ),
        );
        r.register(
          new StoreUserMemoryTool(
            userId,
            embeddingService,
            vectorStore,
            userMemoryRepo,
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

  getCtl(): AssistantControllerConcrete {
    if (!this.ctl) {
      this.ctl = new AssistantControllerConcrete(this.getUseCase());
    }
    return this.ctl;
  }
}
