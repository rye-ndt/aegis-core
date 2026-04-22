import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { OpenAIOrchestrator } from "../implementations/output/orchestrator/openai";
import { ToolRegistryConcrete } from "../implementations/output/toolRegistry.concrete";
import { TavilyWebSearchService } from "../implementations/output/webSearch/tavily.webSearchService";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";
import { ExecuteIntentTool } from "../implementations/output/tools/executeIntent.tool";
import { GetPortfolioTool } from "../implementations/output/tools/getPortfolio.tool";
import type { IToolRegistry } from "../../use-cases/interface/output/tool.interface";
import { DrizzleSqlDB } from "../implementations/output/sqlDB/drizzleSqlDb.adapter";
import { HttpApiServer } from "../implementations/input/http/httpServer";
import type { IAuthUseCase } from "../../use-cases/interface/input/auth.interface";
import { AuthUseCaseImpl } from "../../use-cases/implementations/auth.usecase";
import type { IIntentUseCase } from "../../use-cases/interface/input/intent.interface";
import { IntentUseCaseImpl } from "../../use-cases/implementations/intent.usecase";
import { ViemClientAdapter } from "../implementations/output/blockchain/viemClient";
import { SolverRegistry } from "../implementations/output/solver/solverRegistry";
import { ClaimRewardsSolver } from "../implementations/output/solver/static/claimRewards.solver";
import { OpenAIIntentParser } from "../implementations/output/intentParser/openai.intentParser";
import { OpenAIIntentClassifier } from "../implementations/output/intentParser/openai.intentClassifier";
import { OpenAISchemaCompiler } from "../implementations/output/intentParser/openai.schemaCompiler";
import { ToolRegistrationUseCase } from "../../use-cases/implementations/toolRegistration.usecase";
import type { IToolRegistrationUseCase } from "../../use-cases/interface/input/toolRegistration.interface";
import { DbTokenRegistryService } from "../implementations/output/tokenRegistry/db.tokenRegistry";
import { PangolinTokenCrawler } from "../implementations/output/tokenCrawler/pangolin.tokenCrawler";
import { TokenCrawlerJob } from "../implementations/input/jobs/tokenCrawlerJob";
import { TokenIngestionUseCase } from "../../use-cases/implementations/tokenIngestion.usecase";
import { INTENT_ACTION } from "../../use-cases/interface/output/intentParser.interface";
import { OpenAIEmbeddingService } from "../implementations/output/embedding/openai";
import { PineconeVectorStore } from "../implementations/output/vectorDB/pinecone";
import { PineconeToolIndexService } from "../implementations/output/toolIndex/pinecone.toolIndex";
import type { IToolIndexService } from "../../use-cases/interface/output/toolIndex.interface";
import { PrivyServerAuthAdapter } from "../implementations/output/privyAuth/privyServer.adapter";
import { GramjsTelegramResolver } from "../implementations/output/telegram/gramjs.telegramResolver";
import { RedisSessionDelegationCache } from '../implementations/output/cache/redis.sessionDelegation';
import type { ISessionDelegationCache } from '../../use-cases/interface/output/cache/sessionDelegation.cache';
import { PortfolioUseCaseImpl } from '../../use-cases/implementations/portfolio.usecase';
import type { IPortfolioUseCase } from '../../use-cases/interface/input/portfolio.interface';
import { SessionDelegationUseCaseImpl } from '../../use-cases/implementations/sessionDelegation.usecase';
import type { ISessionDelegationUseCase } from '../../use-cases/interface/input/sessionDelegation.interface';
import { DelegationRequestBuilder } from '../implementations/output/delegation/delegationRequestBuilder';
import type { IDelegationRequestBuilder } from '../../use-cases/interface/output/delegation/delegationRequestBuilder.interface';
import Redis from 'ioredis';
import { SseRegistry } from '../implementations/output/sse/sseRegistry';
import { RedisSigningRequestCache } from '../implementations/output/cache/redis.signingRequest';
import { SigningRequestUseCaseImpl } from '../../use-cases/implementations/signingRequest.usecase';
import type { ISigningRequestUseCase } from '../../use-cases/interface/input/signingRequest.interface';
import { ResolverEngineImpl } from '../implementations/output/resolver/resolverEngine';
import type { IResolverEngine } from '../../use-cases/interface/output/resolver.interface';
import { CommandMappingUseCase } from '../../use-cases/implementations/commandMapping.usecase';
import type { ICommandMappingUseCase } from '../../use-cases/interface/input/commandMapping.interface';
import { BotTelegramNotifier } from "../implementations/output/telegram/botNotifier";
import { RedisUserProfileCache } from "../implementations/output/cache/redis.userProfile";
import type { IUserProfileCache } from "../../use-cases/interface/output/cache/userProfile.cache";
import type { Bot } from "grammy";
import { DrizzleHttpQueryToolRepo } from "../implementations/output/sqlDB/repositories/httpQueryTool.repo";
import { HttpQueryToolUseCaseImpl } from "../../use-cases/implementations/httpQueryTool.usecase";
import { HttpQueryTool } from "../implementations/output/tools/httpQuery.tool";
import type { IHttpQueryToolUseCase } from "../../use-cases/interface/input/httpQueryTool.interface";
import { PrivyWalletDataProvider } from "../implementations/output/walletData/privy.walletDataProvider";
import { SystemToolProviderConcrete } from "../implementations/output/systemToolProvider.concrete";
import type { IWalletDataProvider } from "../../use-cases/interface/output/walletDataProvider.interface";
import type { ISystemToolProvider } from "../../use-cases/interface/output/systemToolProvider.interface";
import { CHAIN_CONFIG } from "../../helpers/chainConfig";
import { DrizzleTokenDelegationRepo } from "../implementations/output/sqlDB/repositories/tokenDelegation.repo";
import type { ITokenDelegationDB } from "../../use-cases/interface/output/repository/tokenDelegation.repo";
import { DeterministicExecutionEstimator } from "../implementations/output/intentParser/deterministic.executionEstimator";
import type { IExecutionEstimator } from "../../use-cases/interface/output/executionEstimator.interface";
import { ZerodevUserOpExecutor } from "../implementations/output/blockchain/zerodevExecutor";
import type { IUserOpExecutor } from "../../use-cases/interface/output/blockchain/userOpExecutor.interface";

export class AssistantInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private useCase: IAssistantUseCase | null = null;
  private _authUseCase: IAuthUseCase | null = null;
  private _intentUseCase: IIntentUseCase | null = null;
  private _userProfileCache: IUserProfileCache | null = null;
  private _bot: Bot | null = null;
  private _viemClient: ViemClientAdapter | null = null;
  private _solverRegistry: SolverRegistry | null = null;
  private _intentParser: OpenAIIntentParser | null = null;
  private _intentClassifier: OpenAIIntentClassifier | null = null;
  private _schemaCompiler: OpenAISchemaCompiler | null = null;
  private _toolRegistrationUseCase: IToolRegistrationUseCase | null = null;
  private _tokenRegistryService: DbTokenRegistryService | null = null;
  private _tokenCrawlerJob: TokenCrawlerJob | null = null;
  private _embeddingService: OpenAIEmbeddingService | null = null;
  private _toolVectorStore: PineconeVectorStore | null = null;
  private _toolIndexService: IToolIndexService | null = null;
  private _privyAuthService: PrivyServerAuthAdapter | null = null;
  private _sessionDelegationCache: ISessionDelegationCache | null = null;
  private _portfolioUseCase: IPortfolioUseCase | null = null;
  private _sessionDelegationUseCase: ISessionDelegationUseCase | null = null;
  private _delegationRequestBuilder: DelegationRequestBuilder | null = null;
  private _telegramHandleResolver: GramjsTelegramResolver | null = null;
  private _redis: Redis | null = null;
  private _sseRegistry: SseRegistry | null = null;
  private _signingRequestUseCase: ISigningRequestUseCase | null = null;
  private _resolverEngine: IResolverEngine | null = null;
  private _commandMappingUseCase: ICommandMappingUseCase | null = null;
  private _httpQueryToolUseCase: IHttpQueryToolUseCase | null = null;
  private _walletDataProvider: IWalletDataProvider | null = null;
  private _systemToolProvider: ISystemToolProvider | null = null;
  private _tokenDelegationRepo: ITokenDelegationDB | null = null;
  private _executionEstimator: IExecutionEstimator | null = null;
  private _userOpExecutor: IUserOpExecutor | null = null;

  private getChainId(): number {
    return CHAIN_CONFIG.chainId;
  }

  getSqlDB(): DrizzleSqlDB {
    if (!this.sqlDB) {
      this.sqlDB = new DrizzleSqlDB({
        connectionString:
          process.env.DATABASE_URL ?? "postgres://localhost:5432/aether_intent",
      });
    }
    return this.sqlDB;
  }

  getViemClient(): ViemClientAdapter {
    if (!this._viemClient) {
      this._viemClient = new ViemClientAdapter({
        rpcUrl: CHAIN_CONFIG.rpcUrl,
        botPrivateKey: "",
        chainId: CHAIN_CONFIG.chainId,
        chain: CHAIN_CONFIG.chain,
      });
    }
    return this._viemClient;
  }

  getTokenRegistryService(): DbTokenRegistryService {
    if (!this._tokenRegistryService) {
      this._tokenRegistryService = new DbTokenRegistryService(
        this.getSqlDB().tokenRegistry,
      );
    }
    return this._tokenRegistryService;
  }

  getTokenCrawlerJob(): TokenCrawlerJob {
    if (!this._tokenCrawlerJob) {
      const intervalMs = parseInt(process.env.TOKEN_CRAWLER_INTERVAL_MS ?? String(15 * 60 * 1000), 10);
      const ingestionUseCase = new TokenIngestionUseCase(
        new PangolinTokenCrawler(),
        this.getSqlDB().tokenRegistry,
      );
      this._tokenCrawlerJob = new TokenCrawlerJob(ingestionUseCase, this.getChainId(), intervalMs);
    }
    return this._tokenCrawlerJob;
  }

  getSolverRegistry(): SolverRegistry {
    if (!this._solverRegistry) {
      const chainId = this.getChainId();
      this._solverRegistry = new SolverRegistry([], this.getSqlDB().toolManifests);
      this._solverRegistry.register(
        INTENT_ACTION.CLAIM_REWARDS,
        new ClaimRewardsSolver(process.env.REWARD_CONTROLLER_ADDRESS ?? ""),
      );

    }
    return this._solverRegistry;
  }

  getEmbeddingService(): OpenAIEmbeddingService | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    if (!this._embeddingService) {
      this._embeddingService = new OpenAIEmbeddingService(apiKey);
    }
    return this._embeddingService;
  }

  getToolVectorStore(): PineconeVectorStore | null {
    const apiKey = process.env.PINECONE_API_KEY;
    const indexName = process.env.PINECONE_INDEX_NAME;
    if (!apiKey || !indexName) return null;
    if (!this._toolVectorStore) {
      this._toolVectorStore = new PineconeVectorStore(
        apiKey,
        indexName,
        process.env.PINECONE_HOST,
      );
    }
    return this._toolVectorStore;
  }

  getPrivyAuthService(): PrivyServerAuthAdapter | undefined {
    const appId = process.env.PRIVY_APP_ID;
    const appSecret = process.env.PRIVY_APP_SECRET;
    if (!appId || !appSecret) return undefined;
    if (!this._privyAuthService) {
      this._privyAuthService = new PrivyServerAuthAdapter(appId, appSecret);
    }
    return this._privyAuthService;
  }

  getToolIndexService(): IToolIndexService | undefined {
    const embeddingService = this.getEmbeddingService();
    const vectorStore = this.getToolVectorStore();
    if (!embeddingService || !vectorStore) return undefined;
    if (!this._toolIndexService) {
      this._toolIndexService = new PineconeToolIndexService(embeddingService, vectorStore);
    }
    return this._toolIndexService;
  }

  getToolRegistrationUseCase(): IToolRegistrationUseCase {
    if (!this._toolRegistrationUseCase) {
      this._toolRegistrationUseCase = new ToolRegistrationUseCase(
        this.getSqlDB().toolManifests,
        this.getToolIndexService(),
      );
    }
    return this._toolRegistrationUseCase;
  }

  getIntentParser(): OpenAIIntentParser {
    if (!this._intentParser) {
      this._intentParser = new OpenAIIntentParser(
        process.env.OPENAI_API_KEY ?? "",
      );
    }
    return this._intentParser;
  }

  getIntentClassifier(): OpenAIIntentClassifier {
    if (!this._intentClassifier) {
      this._intentClassifier = new OpenAIIntentClassifier(
        process.env.OPENAI_API_KEY ?? "",
      );
    }
    return this._intentClassifier;
  }

  getSchemaCompiler(): OpenAISchemaCompiler {
    if (!this._schemaCompiler) {
      this._schemaCompiler = new OpenAISchemaCompiler(
        process.env.OPENAI_API_KEY ?? "",
      );
    }
    return this._schemaCompiler;
  }

  getIntentUseCase(): IIntentUseCase {
    if (!this._intentUseCase) {
      const chainId = this.getChainId();
      const db = this.getSqlDB();
      this._intentUseCase = new IntentUseCaseImpl(
        this.getIntentParser(),
        this.getTokenRegistryService(),
        this.getSolverRegistry(),
        db.intents,
        db.userProfiles,
        db.messages,
        chainId,
        db.toolManifests,
        this.getToolIndexService(),
        this.getIntentClassifier(),
        this.getSchemaCompiler(),
        db.commandToolMappings,
        db.intentExecutions,
        db.tokenDelegations,
        this.getUserOpExecutor(),
      );
    }
    return this._intentUseCase;
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

      const chainId = this.getChainId();
      const intentUseCase = this.getIntentUseCase();
      const tokenRegistryService = this.getTokenRegistryService();
      const viemClient = this.getViemClient();
      const userProfileDB = sqlDB.userProfiles;
      const userProfileCache = this.getUserProfileCache();

      const registryFactory = async (userId: string, conversationId: string): Promise<IToolRegistry> => {
        const r = new ToolRegistryConcrete();

        // Existing static tools
        r.register(new WebSearchTool(webSearchService));
        r.register(new ExecuteIntentTool(userId, conversationId, intentUseCase));
        r.register(new GetPortfolioTool(userId, userProfileDB, tokenRegistryService, viemClient, chainId, userProfileCache));

        // System tools — always available, no DB registration needed
        for (const tool of this.getSystemToolProvider().getTools(userId, conversationId)) {
          r.register(tool);
        }

        // Per-user DB tools (developer-registered HTTP query tools)
        const httpToolDB = this.getSqlDB().httpQueryTools;
        const userHttpTools = await httpToolDB.findActiveByUser(userId);
        const encryptionKey = process.env.HTTP_TOOL_HEADER_ENCRYPTION_KEY;

        for (const toolConfig of userHttpTools) {
          const headers = await httpToolDB.getHeaders(toolConfig.id);
          r.register(
            new HttpQueryTool(
              toolConfig,
              headers,
              userId,
              userProfileCache,
              userProfileDB,
              orchestrator,
              encryptionKey,
            ),
          );
        }

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

  setBot(bot: Bot): void {
    this._bot = bot;
  }

  getBot(): Bot | undefined {
    return this._bot ?? undefined;
  }

  getUserProfileCache(): IUserProfileCache | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._userProfileCache) {
      this._userProfileCache = new RedisUserProfileCache(redis);
    }
    return this._userProfileCache;
  }

  getAuthUseCase(): IAuthUseCase {
    if (!this._authUseCase) {
      const db = this.getSqlDB();
      const bot = this.getBot();
      const notifier = bot ? new BotTelegramNotifier(bot) : undefined;
      this._authUseCase = new AuthUseCaseImpl(
        db.users,
        this.getPrivyAuthService(),
        db.telegramSessions,
        notifier,
        this.getUserProfileCache(),
        db.tokenDelegations,
      );
    }
    return this._authUseCase;
  }

  getRedis(): Redis | undefined {
    const url = process.env.REDIS_URL;
    if (!url) return undefined;
    if (!this._redis) {
      this._redis = new Redis(url, { lazyConnect: false });
      this._redis.on('error', (err: Error) => console.error('[Redis]', err.message));
    }
    return this._redis;
  }

  getSessionDelegationCache(): ISessionDelegationCache | undefined {
    if (!this.getRedis()) return undefined;
    if (!this._sessionDelegationCache) {
      this._sessionDelegationCache = new RedisSessionDelegationCache(this.getRedis()!);
    }
    return this._sessionDelegationCache;
  }

  getAegisGuardCache(): undefined {
    return undefined;
  }

  getTokenDelegationRepo(): ITokenDelegationDB {
    return this.getSqlDB().tokenDelegations;
  }

  getExecutionEstimator(): IExecutionEstimator | undefined {
    if (!this._executionEstimator) {
      this._executionEstimator = new DeterministicExecutionEstimator();
    }
    return this._executionEstimator;
  }

  getUserOpExecutor(): IUserOpExecutor | undefined {
    const botKey = process.env.BOT_PRIVATE_KEY;
    const bundlerUrl = process.env.AVAX_BUNDLER_URL;
    if (!botKey || !bundlerUrl) return undefined;
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(botKey.trim())) {
      console.error("[getUserOpExecutor] BOT_PRIVATE_KEY is not a valid 32-byte hex private key — autonomous execution disabled");
      return undefined;
    }
    if (!this._userOpExecutor) {
      const key = (botKey.startsWith('0x') ? botKey : `0x${botKey}`) as `0x${string}`;
      this._userOpExecutor = new ZerodevUserOpExecutor(
        key,
        bundlerUrl,
        CHAIN_CONFIG.rpcUrl,
        CHAIN_CONFIG.chain,
      );
    }
    return this._userOpExecutor;
  }

  getSseRegistry(): SseRegistry {
    if (!this._sseRegistry) this._sseRegistry = new SseRegistry();
    return this._sseRegistry;
  }

  getSigningRequestUseCase(
    onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
  ): ISigningRequestUseCase | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._signingRequestUseCase) {
      this._signingRequestUseCase = new SigningRequestUseCaseImpl(
        new RedisSigningRequestCache(redis),
        this.getSseRegistry(),
        onResolved,
      );
    }
    return this._signingRequestUseCase;
  }

  getResolverEngine(): IResolverEngine {
    if (!this._resolverEngine) {
      this._resolverEngine = new ResolverEngineImpl(
        this.getTokenRegistryService(),
        this.getSqlDB().userProfiles,
        this.getTelegramHandleResolver(),
        this.getPrivyAuthService(),
      );
    }
    return this._resolverEngine;
  }

  getPortfolioUseCase(): IPortfolioUseCase {
    if (!this._portfolioUseCase) {
      this._portfolioUseCase = new PortfolioUseCaseImpl(
        this.getSqlDB().userProfiles,
        this.getTokenRegistryService(),
        this.getViemClient(),
        this.getChainId(),
      );
    }
    return this._portfolioUseCase;
  }

  getSessionDelegationUseCase(): ISessionDelegationUseCase | undefined {
    const cache = this.getSessionDelegationCache();
    if (!cache) return undefined;
    if (!this._sessionDelegationUseCase) {
      this._sessionDelegationUseCase = new SessionDelegationUseCaseImpl(cache);
    }
    return this._sessionDelegationUseCase;
  }

  getDelegationRequestBuilder(): IDelegationRequestBuilder {
    if (!this._delegationRequestBuilder) {
      this._delegationRequestBuilder = new DelegationRequestBuilder();
    }
    return this._delegationRequestBuilder;
  }

  getTelegramHandleResolver(): GramjsTelegramResolver | undefined {
    const apiId = parseInt(process.env.TG_API_ID ?? "", 10);
    const apiHash = process.env.TG_API_HASH;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!apiId || !apiHash || !botToken) return undefined;
    if (!this._telegramHandleResolver) {
      this._telegramHandleResolver = new GramjsTelegramResolver(
        apiId,
        apiHash,
        botToken,
        process.env.TG_SESSION ?? "",
      );
    }
    return this._telegramHandleResolver;
  }

  getHttpQueryToolUseCase(): IHttpQueryToolUseCase {
    if (!this._httpQueryToolUseCase) {
      this._httpQueryToolUseCase = new HttpQueryToolUseCaseImpl(
        this.getSqlDB().httpQueryTools,
        process.env.HTTP_TOOL_HEADER_ENCRYPTION_KEY,
      );
    }
    return this._httpQueryToolUseCase;
  }

  getWalletDataProvider(): IWalletDataProvider {
    if (!this._walletDataProvider) {
      this._walletDataProvider = new PrivyWalletDataProvider(
        process.env.PRIVY_APP_ID ?? "",
        process.env.PRIVY_APP_SECRET ?? "",
      );
    }
    return this._walletDataProvider;
  }

  getSystemToolProvider(): ISystemToolProvider {
    if (!this._systemToolProvider) {
      this._systemToolProvider = new SystemToolProviderConcrete(
        this.getIntentUseCase(),
        this.getWalletDataProvider(),
        this.getUserProfileCache(),
      );
    }
    return this._systemToolProvider;
  }

  getCommandMappingUseCase(): ICommandMappingUseCase {
    if (!this._commandMappingUseCase) {
      const db = this.getSqlDB();
      this._commandMappingUseCase = new CommandMappingUseCase(
        db.commandToolMappings,
        db.toolManifests,
      );
    }
    return this._commandMappingUseCase;
  }

  getHttpApiServer(signingRequestUseCase?: ISigningRequestUseCase): HttpApiServer {
    const port = parseInt(process.env.HTTP_API_PORT ?? "4000", 10);
    return new HttpApiServer(
      this.getAuthUseCase(),
      port,
      process.env.JWT_SECRET,
      this.getIntentUseCase(),
      this.getPortfolioUseCase(),
      this.getToolRegistrationUseCase(),
      this.getSessionDelegationUseCase(),
      this.getSqlDB().pendingDelegations,
      this.getSseRegistry(),
      signingRequestUseCase,
      this.getCommandMappingUseCase(),
      this.getUserProfileCache(),
      this.getHttpQueryToolUseCase(),
      this.getSqlDB().userPreferences,
      this.getTokenDelegationRepo(),
      this.getSqlDB().userProfiles,
    );
  }
}
