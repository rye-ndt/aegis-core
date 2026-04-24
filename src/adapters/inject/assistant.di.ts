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
import { metricsRegistry } from "../../helpers/observability/metricsRegistry";
import { createLogger } from "../../helpers/observability/logger";
import { RedisSigningRequestCache } from '../implementations/output/cache/redis.signingRequest';
import { RedisMiniAppRequestCache } from '../implementations/output/cache/redis.miniAppRequest';
import type { IMiniAppRequestCache } from '../../use-cases/interface/output/cache/miniAppRequest.cache';
import { SigningRequestUseCaseImpl } from '../../use-cases/implementations/signingRequest.usecase';
import type { ISigningRequestUseCase } from '../../use-cases/interface/input/signingRequest.interface';
import { ResolverEngineImpl } from '../implementations/output/resolver/resolverEngine';
import type { IResolverEngine } from '../../use-cases/interface/output/resolver.interface';
import { CommandMappingUseCase } from '../../use-cases/implementations/commandMapping.usecase';
import type { ICommandMappingUseCase } from '../../use-cases/interface/input/commandMapping.interface';
import { BotTelegramNotifier } from "../implementations/output/telegram/botNotifier";
import type { ITelegramNotifier } from "../../use-cases/interface/output/telegramNotifier.interface";
import { RedisUserProfileCache } from "../implementations/output/cache/redis.userProfile";
import type { IUserProfileCache } from "../../use-cases/interface/output/cache/userProfile.cache";
import type { Bot } from "grammy";
import { HttpQueryToolUseCaseImpl } from "../../use-cases/implementations/httpQueryTool.usecase";
import { HttpQueryTool } from "../implementations/output/tools/httpQuery.tool";
import type { IHttpQueryToolUseCase } from "../../use-cases/interface/input/httpQueryTool.interface";
import { PrivyWalletDataProvider } from "../implementations/output/walletData/privy.walletDataProvider";
import { SystemToolProviderConcrete } from "../implementations/output/systemToolProvider.concrete";
import type { IWalletDataProvider } from "../../use-cases/interface/output/walletDataProvider.interface";
import type { ISystemToolProvider } from "../../use-cases/interface/output/systemToolProvider.interface";
import { CHAIN_CONFIG } from "../../helpers/chainConfig";
import type { ITokenDelegationDB } from "../../use-cases/interface/output/repository/tokenDelegation.repo";
import { DeterministicExecutionEstimator } from "../implementations/output/intentParser/deterministic.executionEstimator";
import type { IExecutionEstimator } from "../../use-cases/interface/output/executionEstimator.interface";
import { CapabilityRegistry } from "../../use-cases/implementations/capabilityRegistry";
import { CapabilityDispatcher } from "../../use-cases/implementations/capabilityDispatcher.usecase";
import type { ICapabilityDispatcher } from "../../use-cases/interface/input/capabilityDispatcher.interface";
import { InMemoryPendingCollectionStore } from "../implementations/output/pendingCollectionStore/inMemory";
import { RedisPendingCollectionStore } from "../implementations/output/pendingCollectionStore/redis";
import type { IPendingCollectionStore } from "../../use-cases/interface/output/pendingCollectionStore.interface";
import { TelegramArtifactRenderer } from "../implementations/output/artifactRenderer/telegram";
import { BuyCapability } from "../implementations/output/capabilities/buyCapability";
import { AssistantChatCapability } from "../implementations/output/capabilities/assistantChatCapability";
import { SendCapability } from "../implementations/output/capabilities/sendCapability";
import { SwapCapability } from "../implementations/output/capabilities/swapCapability";
import { RelayClient } from "../implementations/output/relay/relayClient";
import { RelaySwapTool } from "../implementations/output/tools/system/relaySwap.tool";
import type { IRelayClient } from "../../use-cases/interface/output/relay.interface";
import { INTENT_COMMAND } from "../../helpers/enums/intentCommand.enum";
import { AaveV3Adapter } from "../implementations/output/yield/aaveV3Adapter";
import { YieldProtocolRegistry } from "../implementations/output/yield/yieldProtocolRegistry";
import { YieldPoolRanker } from "../../use-cases/implementations/yieldPoolRanker";
import { YieldOptimizerUseCase } from "../../use-cases/implementations/yieldOptimizerUseCase";
import type { IYieldOptimizerUseCase } from "../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { IYieldRepository } from "../../use-cases/interface/yield/IYieldRepository";
import { YieldPoolScanJob } from "../implementations/input/jobs/yieldPoolScanJob";
import { UserIdleScanJob } from "../implementations/input/jobs/userIdleScanJob";
import { YieldReportJob } from "../implementations/input/jobs/yieldReportJob";
import { YieldCapability, buildNudgeKeyboard } from "../implementations/output/capabilities/yieldCapability";
import { getYieldConfig, getEnabledYieldChains, getChainRpcUrl, getChainRpcUrls, getChainObject } from "../../helpers/chainConfig";
import { YIELD_ENV } from "../../helpers/env/yieldEnv";
import type { DailyReport } from "../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { YIELD_PROTOCOL_ID } from "../../helpers/enums/yieldProtocolId.enum";

const log = createLogger("assistantDI");

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
  private _miniAppRequestCache: IMiniAppRequestCache | null = null;
  private _signingRequestUseCase: ISigningRequestUseCase | null = null;
  private _resolverEngine: IResolverEngine | null = null;
  private _commandMappingUseCase: ICommandMappingUseCase | null = null;
  private _httpQueryToolUseCase: IHttpQueryToolUseCase | null = null;
  private _walletDataProvider: IWalletDataProvider | null = null;
  private _telegramNotifier: ITelegramNotifier | null = null;
  private _systemToolProvider: ISystemToolProvider | null = null;
  private _executionEstimator: IExecutionEstimator | null = null;
  private _capabilityDispatcher: ICapabilityDispatcher | null = null;
  private _relayClient: IRelayClient | null = null;
  private _relaySwapTool: RelaySwapTool | null = null;
  private _yieldProtocolRegistry: YieldProtocolRegistry | null = null;
  private _yieldOptimizerUseCase: IYieldOptimizerUseCase | null = null;
  private _yieldPoolScanJob: YieldPoolScanJob | null = null;
  private _userIdleScanJob: UserIdleScanJob | null = null;
  private _yieldReportJob: YieldReportJob | null = null;

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
        rpcUrls: CHAIN_CONFIG.rpcUrls as string[],
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
        this.getRedis(),
      );

      const chainId = this.getChainId();
      const intentUseCase = this.getIntentUseCase();
      const tokenRegistryService = this.getTokenRegistryService();
      const viemClient = this.getViemClient();
      const userProfileDB = sqlDB.userProfiles;
      const userProfileCache = this.getUserProfileCache();

      const registryFactory = async (userId: string, conversationId: string): Promise<IToolRegistry> => {
        const r = new ToolRegistryConcrete();

        r.register(new WebSearchTool(webSearchService));
        r.register(new ExecuteIntentTool(userId, conversationId, intentUseCase));
        r.register(new GetPortfolioTool(userId, userProfileDB, tokenRegistryService, viemClient, chainId, userProfileCache));

        for (const tool of this.getSystemToolProvider().getTools(userId, conversationId)) {
          r.register(tool);
        }

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
      this._authUseCase = new AuthUseCaseImpl(
        db.users,
        this.getPrivyAuthService(),
        db.telegramSessions,
        this.getTelegramNotifier(),
        this.getUserProfileCache(),
      );
    }
    return this._authUseCase;
  }

  getRedis(): Redis | undefined {
    const url = process.env.REDIS_URL;
    if (!url) return undefined;
    if (!this._redis) {
      this._redis = new Redis(url, { lazyConnect: false });
      this._redis.on('error', (err: Error) => log.error({ err }, 'Redis error'));
      this._redis.on('ready', () => log.info('Redis ready'));
      metricsRegistry.bindRedis(this._redis);
      const _origSend = this._redis.sendCommand.bind(this._redis);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._redis as any).sendCommand = (cmd: any) => {
        const start = Date.now();
        const promise = _origSend(cmd);
        Promise.resolve(promise).finally(() => metricsRegistry.recordRedisOp(Date.now() - start));
        return promise;
      };
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

  getMiniAppRequestCache(): IMiniAppRequestCache | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._miniAppRequestCache) {
      this._miniAppRequestCache = new RedisMiniAppRequestCache(redis);
    }
    return this._miniAppRequestCache;
  }

  getTelegramNotifier(): ITelegramNotifier | undefined {
    if (this._telegramNotifier) return this._telegramNotifier;
    const bot = this.getBot();
    if (!bot) return undefined;
    this._telegramNotifier = new BotTelegramNotifier(bot);
    return this._telegramNotifier;
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

  getSigningRequestUseCase(
    onResolved: (chatId: number, txHash: string | undefined, rejected: boolean) => void,
  ): ISigningRequestUseCase | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._signingRequestUseCase) {
      this._signingRequestUseCase = new SigningRequestUseCaseImpl(
        new RedisSigningRequestCache(redis),
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

  getRelayClient(): IRelayClient {
    if (!this._relayClient) {
      this._relayClient = new RelayClient(undefined, this.getRedis());
    }
    return this._relayClient;
  }

  getRelaySwapTool(): RelaySwapTool {
    if (!this._relaySwapTool) {
      this._relaySwapTool = new RelaySwapTool(this.getRelayClient());
    }
    return this._relaySwapTool;
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

  /**
   * Builds the capability dispatcher used by input adapters (Telegram first).
   * Returns undefined if no bot has been attached yet — capabilities that
   * need to render to Telegram require a live Bot reference.
   */
  getCapabilityDispatcher(): ICapabilityDispatcher | undefined {
    if (this._capabilityDispatcher) return this._capabilityDispatcher;
    const bot = this.getBot();
    if (!bot) return undefined;

    const registry = new CapabilityRegistry();
    const redisForPending = this.getRedis();
    const pending: IPendingCollectionStore = redisForPending
      ? new RedisPendingCollectionStore(redisForPending)
      : new InMemoryPendingCollectionStore();
    const renderer = new TelegramArtifactRenderer(bot, this.getMiniAppRequestCache());
    const sqlDB = this.getSqlDB();

    // Register capabilities here. Order does not matter.
    registry.register(new BuyCapability(sqlDB.userProfiles, this.getChainId()));

    const sendDeps = {
      intentUseCase: this.getIntentUseCase(),
      resolverEngine: this.getResolverEngine(),
      tokenDelegationDB: this.getTokenDelegationRepo(),
      executionEstimator: this.getExecutionEstimator(),
      telegramHandleResolver: this.getTelegramHandleResolver(),
      privyAuthService: this.getPrivyAuthService(),
      userProfileRepo: sqlDB.userProfiles,
      pendingDelegationRepo: sqlDB.pendingDelegations,
      delegationBuilder: this.getDelegationRequestBuilder(),
      chainId: this.getChainId(),
    };

    // One SendCapability instance per INTENT_COMMAND (except BUY and SWAP,
    // which own their own dedicated capabilities). All share the same deps +
    // compile→resolve→sign pipeline; the command is just a trigger.
    for (const command of Object.values(INTENT_COMMAND)) {
      if (command === INTENT_COMMAND.BUY) continue;
      if (command === INTENT_COMMAND.SWAP) continue;
      if (command === INTENT_COMMAND.YIELD) continue;
      if (command === INTENT_COMMAND.WITHDRAW) continue;
      registry.register(new SendCapability(command, sendDeps));
    }

    // /swap — Relay-backed intent swap. Requires a live signing-request
    // use case (created in telegramCli.ts before this dispatcher) because
    // step-by-step execution awaits each signing response. If Redis isn't
    // configured the capability is skipped silently — same policy as
    // mini-app dependent capabilities elsewhere.
    if (this._signingRequestUseCase) {
      registry.register(
        new SwapCapability({
          intentUseCase: this.getIntentUseCase(),
          resolverEngine: this.getResolverEngine(),
          relaySwapTool: this.getRelaySwapTool(),
          signingRequestUseCase: this._signingRequestUseCase,
          tokenDelegationDB: this.getTokenDelegationRepo(),
          executionEstimator: this.getExecutionEstimator(),
          userProfileRepo: sqlDB.userProfiles,
          chainId: this.getChainId(),
        }),
      );
    } else {
      log.warn({ reason: "redis_unavailable" }, "/swap capability skipped — signing-request use case not ready");
    }

    const yieldOptimizer = this.getYieldOptimizerUseCase();
    if (yieldOptimizer) {
      registry.register(
        new YieldCapability({
          optimizer: yieldOptimizer,
          miniAppRequestCache: this.getMiniAppRequestCache(),
          signingRequestUseCase: this._signingRequestUseCase ?? undefined,
        }),
      );
    } else {
      log.warn({ reason: "redis_unavailable" }, "/yield capability skipped");
    }

    // Free-text fallback: the LLM loop. Handles anything that isn't a slash
    // command and isn't continuing a pending capability flow.
    registry.registerDefault(new AssistantChatCapability(this.getUseCase()));

    this._capabilityDispatcher = new CapabilityDispatcher(registry, renderer, pending);
    return this._capabilityDispatcher;
  }

  getYieldRepo(): IYieldRepository {
    return this.getSqlDB().yieldRepo;
  }

  getYieldProtocolRegistry(): YieldProtocolRegistry {
    if (!this._yieldProtocolRegistry) {
      const adapters: AaveV3Adapter[] = [];
      for (const chainId of getEnabledYieldChains()) {
        const yieldConfig = getYieldConfig(chainId);
        if (!yieldConfig?.aave) continue;
        const chain = getChainObject(chainId);
        if (!chain) continue;
        // Prefer env override for the configured chain; otherwise use default RPC from registry.
        const rpcUrls =
          chainId === CHAIN_CONFIG.chainId
            ? (CHAIN_CONFIG.rpcUrls as string[])
            : getChainRpcUrls(chainId);
        adapters.push(
          new AaveV3Adapter(
            chainId,
            yieldConfig.aave.poolAddress,
            yieldConfig.aave.dataProviderAddress,
            rpcUrls[0] ?? "",
            chain,
            rpcUrls,
          ),
        );
      }
      this._yieldProtocolRegistry = new YieldProtocolRegistry(adapters);
    }
    return this._yieldProtocolRegistry;
  }

  getYieldOptimizerUseCase(): IYieldOptimizerUseCase | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._yieldOptimizerUseCase) {
      const bot = this.getBot();
      const sqlDB = this.getSqlDB();

      const sendNudge = async (
        userId: string,
        chatId: string,
        apy: number,
        bestProtocolId: YIELD_PROTOCOL_ID,
      ): Promise<void> => {
        if (!bot) return;
        const apyPct = (apy * 100).toFixed(2);
        await bot.api.sendMessage(
          Number(chatId),
          `💰 Your idle USDC is earning nothing. ${bestProtocolId} is currently offering ${apyPct}% APY.\n\nHow much would you like to optimize?`,
          { reply_markup: buildNudgeKeyboard() },
        );
      };

      this._yieldOptimizerUseCase = new YieldOptimizerUseCase({
        protocolRegistry: this.getYieldProtocolRegistry(),
        ranker: new YieldPoolRanker(),
        yieldRepo: this.getYieldRepo(),
        userProfileRepo: sqlDB.userProfiles,
        chainReader: this.getViemClient(),
        redis,
        nudgeCooldownSec: YIELD_ENV.nudgeCooldownSec,
        idleThresholdUsd: YIELD_ENV.idleUsdcThresholdUsd,
        sendNudge,
      });
    }
    return this._yieldOptimizerUseCase;
  }

  getYieldPoolScanJob(): YieldPoolScanJob | undefined {
    const optimizer = this.getYieldOptimizerUseCase();
    if (!optimizer) return undefined;
    if (!this._yieldPoolScanJob) {
      this._yieldPoolScanJob = new YieldPoolScanJob(optimizer, YIELD_ENV.poolScanIntervalMs);
    }
    return this._yieldPoolScanJob;
  }

  getUserIdleScanJob(): UserIdleScanJob | undefined {
    const optimizer = this.getYieldOptimizerUseCase();
    if (!optimizer) return undefined;
    if (!this._userIdleScanJob) {
      this._userIdleScanJob = new UserIdleScanJob(
        optimizer,
        this.getSqlDB().telegramSessions,
        YIELD_ENV.userScanIntervalMs,
      );
    }
    return this._userIdleScanJob;
  }

  getYieldReportJob(): YieldReportJob | undefined {
    const optimizer = this.getYieldOptimizerUseCase();
    const redis = this.getRedis();
    if (!optimizer || !redis) return undefined;
    if (!this._yieldReportJob) {
      const sqlDB = this.getSqlDB();
      const bot = this.getBot();

      const sendReport = async (_userId: string, chatId: string, report: DailyReport): Promise<void> => {
        if (!bot) return;
        const lines = ["📊 *Daily Yield Report*", ""];
        for (const pos of report.positions) {
          const yieldCfg = getYieldConfig(pos.chainId);
          const stable = yieldCfg?.stablecoins.find(
            (s) => s.address.toLowerCase() === pos.tokenAddress.toLowerCase(),
          );
          if (!stable) continue;
          const { decimals, symbol } = stable;
          const balance = (Number(pos.balanceRaw) / Math.pow(10, decimals)).toFixed(4);
          const delta = (Number(pos.delta24hRaw) / Math.pow(10, decimals)).toFixed(4);
          const pnl = (Number(pos.lifetimePnlRaw) / Math.pow(10, decimals)).toFixed(4);
          const deltaPrefix = Number(pos.delta24hRaw) >= 0 ? "+" : "";
          lines.push(
            `*${pos.protocolId}* — ${balance} ${symbol}`,
            `  24h: ${deltaPrefix}${delta} ${symbol}`,
            `  Lifetime PnL: ${pnl} ${symbol}`,
            "",
          );
        }
        await bot.api.sendMessage(Number(chatId), lines.join("\n"), { parse_mode: "Markdown" });
      };

      this._yieldReportJob = new YieldReportJob(
        optimizer,
        this.getYieldRepo(),
        redis,
        YIELD_ENV.reportUtcHour,
        sendReport,
        async (userId) => {
          const session = await sqlDB.telegramSessions.findByUserId(userId);
          return session?.telegramChatId ?? null;
        },
      );
    }
    return this._yieldReportJob;
  }

  getHttpApiServer(signingRequestUseCase?: ISigningRequestUseCase): HttpApiServer {
    const port = parseInt(process.env.HTTP_API_PORT ?? "4000", 10);
    return new HttpApiServer(
      this.getAuthUseCase(),
      port,
      this.getIntentUseCase(),
      this.getPortfolioUseCase(),
      this.getToolRegistrationUseCase(),
      this.getSessionDelegationUseCase(),
      this.getSqlDB().pendingDelegations,
      this.getMiniAppRequestCache(),
      signingRequestUseCase,
      this.getCommandMappingUseCase(),
      this.getUserProfileCache(),
      this.getHttpQueryToolUseCase(),
      this.getSqlDB().userPreferences,
      this.getTokenDelegationRepo(),
      this.getSqlDB().userProfiles,
      this.getSqlDB().telegramSessions,
      this.getTelegramNotifier(),
      this.getYieldOptimizerUseCase(),
    );
  }
}
