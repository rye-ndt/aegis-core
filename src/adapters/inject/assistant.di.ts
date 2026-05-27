import type { Bot } from "grammy";
import Redis from "ioredis";
import {
  CHAIN_CONFIG,
  getAnkrBlockchain,
  getChainObject,
  getChainRpcUrls,
  getEnabledYieldChains,
  getYieldConfig,
} from "../../helpers/chainConfig";
import { INTENT_COMMAND } from "../../helpers/enums/intentCommand.enum";
import type { YIELD_PROTOCOL_ID } from "../../helpers/enums/yieldProtocolId.enum";
import { LOYALTY_ENV } from "../../helpers/env/loyaltyEnv";
import { OPENROUTER_MODEL } from "../../helpers/env/openrouterEnv";
import { isOpenRouterConfigured } from "../../helpers/llm/openrouterClient";
import { TRANSFER_HISTORY_ENV } from "../../helpers/env/transferHistoryEnv";
import { YIELD_ENV } from "../../helpers/env/yieldEnv";
import { createLogger } from "../../helpers/observability/logger";
import { metricsRegistry } from "../../helpers/observability/metricsRegistry";
import { AssistantUseCaseImpl } from "../../use-cases/implementations/assistant.usecase";
import { AuthUseCaseImpl } from "../../use-cases/implementations/auth.usecase";
import { CapabilityDispatcher } from "../../use-cases/implementations/capabilityDispatcher.usecase";
import { CapabilityRegistry } from "../../use-cases/implementations/capabilityRegistry";
import { IntentUseCaseImpl } from "../../use-cases/implementations/intent.usecase";
import { LoyaltyUseCaseImpl } from "../../use-cases/implementations/loyaltyUseCase";
import { PortfolioUseCaseImpl } from "../../use-cases/implementations/portfolio.usecase";
import { RecipientNotificationUseCase } from "../../use-cases/implementations/recipientNotification.useCase";
import { SessionDelegationUseCaseImpl } from "../../use-cases/implementations/sessionDelegation.usecase";
import { SigningRequestUseCaseImpl } from "../../use-cases/implementations/signingRequest.usecase";
import { TokenIngestionUseCase } from "../../use-cases/implementations/tokenIngestion.usecase";
import { TransferHistoryUseCaseImpl } from "../../use-cases/implementations/transferHistory.usecase";
import { YieldOptimizerUseCase } from "../../use-cases/implementations/yieldOptimizerUseCase";
import { YieldPoolRanker } from "../../use-cases/implementations/yieldPoolRanker";
import type { IAssistantUseCase } from "../../use-cases/interface/input/assistant.interface";
import type { IAuthUseCase } from "../../use-cases/interface/input/auth.interface";
import type { ICapabilityDispatcher } from "../../use-cases/interface/input/capabilityDispatcher.interface";
import type { IIntentUseCase } from "../../use-cases/interface/input/intent.interface";
import type { ILoyaltyUseCase } from "../../use-cases/interface/input/loyalty.interface";
import type { IPortfolioUseCase } from "../../use-cases/interface/input/portfolio.interface";
import type { ISessionDelegationUseCase } from "../../use-cases/interface/input/sessionDelegation.interface";
import type { ISigningRequestUseCase } from "../../use-cases/interface/input/signingRequest.interface";
import type { ITransferHistoryUseCase } from "../../use-cases/interface/input/transferHistory.interface";
import type { IBalanceProvider } from "../../use-cases/interface/output/blockchain/balanceProvider.interface";
import type { ITransferHistoryProvider } from "../../use-cases/interface/output/blockchain/transferHistoryProvider.interface";
import type { IMiniAppRequestCache } from "../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { ISessionDelegationCache } from "../../use-cases/interface/output/cache/sessionDelegation.cache";
import type { ITransferHistoryCache } from "../../use-cases/interface/output/cache/transferHistory.cache";
import type { IUserProfileCache } from "../../use-cases/interface/output/cache/userProfile.cache";
import type { IDelegationRequestBuilder } from "../../use-cases/interface/output/delegation/delegationRequestBuilder.interface";
import type { IPendingCollectionStore } from "../../use-cases/interface/output/pendingCollectionStore.interface";
import type { IRelayClient } from "../../use-cases/interface/output/relay.interface";
import type { ITokenDelegationDB } from "../../use-cases/interface/output/repository/tokenDelegation.repo";
import type { IResolverEngine } from "../../use-cases/interface/output/resolver.interface";
import type { ISystemToolProvider } from "../../use-cases/interface/output/systemToolProvider.interface";
import type { ITelegramNotifier } from "../../use-cases/interface/output/telegramNotifier.interface";
import type { ITool } from "../../use-cases/interface/output/tool.interface";
import type { IToolIndexService } from "../../use-cases/interface/output/toolIndex.interface";
import type { IWalletDataProvider } from "../../use-cases/interface/output/walletDataProvider.interface";
import type {
  DailyReport,
  IYieldOptimizerUseCase,
} from "../../use-cases/interface/yield/IYieldOptimizerUseCase";
import type { IYieldRepository } from "../../use-cases/interface/yield/IYieldRepository";
import { HttpApiServer } from "../implementations/input/http/httpServer";
import { PimlicoBundlerProxy } from "../implementations/output/aa/pimlicoBundlerProxy";
import { TokenCrawlerJob } from "../implementations/input/jobs/tokenCrawlerJob";
import { UserIdleScanJob } from "../implementations/input/jobs/userIdleScanJob";
import { YieldPoolScanJob } from "../implementations/input/jobs/yieldPoolScanJob";
import { YieldReportJob } from "../implementations/input/jobs/yieldReportJob";
import { PredictionMarketScanJob } from "../implementations/input/jobs/predictionMarketScanJob";
import { PredictionMarketExtractFactsJob } from "../implementations/input/jobs/predictionMarketExtractFactsJob";
import { OpenRouterPredictionMarketExtractor } from "../implementations/output/predictionMarket/openrouterPredictionMarketExtractor";
import { PredictionMarketExtractFactsUseCase } from "../../use-cases/implementations/predictionMarketExtractFacts.usecase";
import { PredictionMarketReviewHandler } from "../implementations/input/telegram/predictionMarketReviewHandler";
import { PolymarketPositionPollerJob } from "../implementations/input/jobs/polymarketPositionPollerJob";
import { PredictionMarketStuckBetSweeperJob } from "../implementations/input/jobs/predictionMarketStuckBetSweeperJob";
import { PolymarketProvider } from "../implementations/output/predictionMarket/polymarketProvider";
import { OpenRouterPredictionMarketClassifier } from "../implementations/output/predictionMarket/openrouterPredictionMarketClassifier";
import { OpenRouterPredictionMarketDetector } from "../implementations/output/predictionMarket/openrouterPredictionMarketDetector";
import { DeterministicPredictionMarketDetector } from "../implementations/output/predictionMarket/deterministicPredictionMarketDetector";
import { AnalyticalPredictionMarketSizer } from "../implementations/output/predictionMarket/analyticalPredictionMarketSizer";
import { PredictionMarketBroadcaster } from "../implementations/output/predictionMarket/predictionMarketBroadcaster";
import { PredictionMarketFindingBroadcaster } from "../implementations/output/predictionMarket/predictionMarketFindingBroadcaster";
import { PredictionMarketReceiptBroadcaster } from "../implementations/output/predictionMarket/predictionMarketReceiptBroadcaster";
import { PolymarketAdapter } from "../implementations/output/predictionMarket/polymarketAdapter";
import { PredictionMarketVerifier } from "../implementations/output/predictionMarket/predictionMarketVerifier";
import { PredictionMarketScanUseCase } from "../../use-cases/implementations/predictionMarketScan.usecase";
import { PredictionMarketDeterministicClusterUseCase } from "../../use-cases/implementations/predictionMarketDeterministicCluster.usecase";
import { PredictionMarketBetUseCase } from "../../use-cases/implementations/predictionMarketBet.usecase";
import { DrizzlePredictionMarketBetRepo } from "../implementations/output/sqlDB/repositories/predictionMarketBet.repo";
import { PlaceBetCapability } from "../implementations/output/capabilities/placeBetCapability";
import { ClosePositionCapability } from "../implementations/output/capabilities/closePositionCapability";
import { PREDICTION_MARKETS_ENV } from "../../helpers/env/predictionMarketEnv";
import type { IPredictionMarketBroadcaster } from "../../use-cases/interface/predictionMarket/IPredictionMarketBroadcaster";
import type { IPredictionMarketClassifier } from "../../use-cases/interface/predictionMarket/IPredictionMarketClassifier";
import type { IPredictionMarketDetector } from "../../use-cases/interface/predictionMarket/IPredictionMarketDetector";
import type { IPredictionMarketFindingBroadcaster } from "../../use-cases/interface/predictionMarket/IPredictionMarketFindingBroadcaster";
import type { IPredictionMarketProvider } from "../../use-cases/interface/predictionMarket/IPredictionMarketProvider";
import type { IPredictionMarketRepository } from "../../use-cases/interface/predictionMarket/IPredictionMarketRepository";
import type { IPredictionMarketVerifier } from "../../use-cases/interface/predictionMarket/IPredictionMarketVerifier";
import type { IPredictionMarketBetRepository } from "../../use-cases/interface/predictionMarket/IPredictionMarketBetRepository";
import type { IPredictionMarketBetUseCase } from "../../use-cases/interface/predictionMarket/IPredictionMarketBetUseCase";
import type { IPredictionMarketReceiptBroadcaster } from "../../use-cases/interface/predictionMarket/IPredictionMarketReceiptBroadcaster";
import type { IPolymarketReadAdapter } from "../../use-cases/interface/predictionMarket/IPolymarketAdapter";
import { TelegramArtifactRenderer } from "../implementations/output/artifactRenderer/telegram";
import { AnkrBalanceProvider } from "../implementations/output/balance/ankrBalanceProvider";
import { CachedBalanceProvider } from "../implementations/output/balance/cachedBalanceProvider";
import { RpcBalanceProvider } from "../implementations/output/balance/rpcBalanceProvider";
import { ViemClientAdapter } from "../implementations/output/blockchain/viemClient";
import { RedisMiniAppRequestCache } from "../implementations/output/cache/redis.miniAppRequest";
import { RedisSessionDelegationCache } from "../implementations/output/cache/redis.sessionDelegation";
import { RedisSigningRequestCache } from "../implementations/output/cache/redis.signingRequest";
import { RedisTransferHistoryCache } from "../implementations/output/cache/redis.transferHistory";
import { RedisUserProfileCache } from "../implementations/output/cache/redis.userProfile";
import { AssistantChatCapability } from "../implementations/output/capabilities/assistantChatCapability";
import { BuyCapability } from "../implementations/output/capabilities/buyCapability";
import { LoyaltyCapability } from "../implementations/output/capabilities/loyaltyCapability";
import { SendCapability } from "../implementations/output/capabilities/sendCapability";
import { SwapCapability } from "../implementations/output/capabilities/swapCapability";
import {
  YieldCapability,
  buildNudgeKeyboard,
  buildRebalanceNudgeKeyboard,
} from "../implementations/output/capabilities/yieldCapability";
import { DelegationRequestBuilder } from "../implementations/output/delegation/delegationRequestBuilder";
import { OpenAIEmbeddingService } from "../implementations/output/embedding/openai";
import { OpenRouterSchemaCompiler } from "../implementations/output/intentParser/openrouter.schemaCompiler";
import { OpenRouterOrchestrator } from "../implementations/output/orchestrator/openrouter";
import { OpenRouterIntentInterpreter } from "../implementations/output/intentInterpreter/openrouter.intentInterpreter";
import { makeRedisResponseCache } from "../../helpers/cache/redisResponseCache";
import { getResultCardEnv } from "../../helpers/env/resultCardEnv";
import type { IIntentInterpreter } from "../../use-cases/interface/output/intentInterpreter.interface";
import { InMemoryPendingCollectionStore } from "../implementations/output/pendingCollectionStore/inMemory";
import { RedisPendingCollectionStore } from "../implementations/output/pendingCollectionStore/redis";
import { RedisPendingIntentStore } from "../implementations/output/cache/redis.pendingIntent";
import type { IPendingIntentStore } from "../../use-cases/interface/output/cache/pendingIntent.cache";
import { PrivyServerAuthAdapter } from "../implementations/output/privyAuth/privyServer.adapter";
import { RelayClient } from "../implementations/output/relay/relayClient";
import { ResolverEngineImpl } from "../implementations/output/resolver/resolverEngine";
import { SolverRegistry } from "../implementations/output/solver/solverRegistry";
import { DrizzleSqlDB } from "../implementations/output/sqlDB/drizzleSqlDb.adapter";
import { SystemToolProviderConcrete } from "../implementations/output/systemToolProvider.concrete";
import { BotTelegramNotifier } from "../implementations/output/telegram/botNotifier";
import { GramjsTelegramResolver } from "../implementations/output/telegram/gramjs.telegramResolver";
import { PangolinTokenCrawler } from "../implementations/output/tokenCrawler/pangolin.tokenCrawler";
import { DbTokenRegistryService } from "../implementations/output/tokenRegistry/db.tokenRegistry";
import { PineconeToolIndexService } from "../implementations/output/toolIndex/pinecone.toolIndex";
import { GetPortfolioTool } from "../implementations/output/tools/getPortfolio.tool";
import { RouteIntentTool } from "../implementations/output/tools/routeIntent.tool";
import { RelaySwapTool } from "../implementations/output/tools/system/relaySwap.tool";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";
import { AnkrTransferHistoryProvider } from "../implementations/output/transferHistory/ankrTransferHistoryProvider";
import { CachedTransferHistoryProvider } from "../implementations/output/transferHistory/cachedTransferHistoryProvider";
import { PineconeVectorStore } from "../implementations/output/vectorDB/pinecone";
import { PrivyWalletDataProvider } from "../implementations/output/walletData/privy.walletDataProvider";
import { TavilyWebSearchService } from "../implementations/output/webSearch/tavily.webSearchService";
import { AaveV3Adapter } from "../implementations/output/yield/aaveV3Adapter";
import { OnChainPositionDiscovery } from "../implementations/output/yield/onChainPositionDiscovery";
import { SubgraphPrincipalProvider } from "../implementations/output/yield/subgraphPrincipalProvider";
import { YieldProtocolRegistry } from "../implementations/output/yield/yieldProtocolRegistry";
import { renderResultCard } from "../implementations/output/artifactRenderer/resultCard.render";
import type {
  IntentResult,
  ResultField,
} from "../../use-cases/interface/input/resultCard.types";

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
  private _schemaCompiler: OpenRouterSchemaCompiler | null = null;
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
  private _walletDataProvider: IWalletDataProvider | null = null;
  private _telegramNotifier: ITelegramNotifier | null = null;
  private _systemToolProvider: ISystemToolProvider | null = null;
  private _intentInterpreter: IIntentInterpreter | null = null;
  private _intentInterpreterChecked = false;
  private _capabilityDispatcher: ICapabilityDispatcher | null = null;
  private _pendingIntentStore: IPendingIntentStore | null = null;
  private _relayClient: IRelayClient | null = null;
  private _relaySwapTool: RelaySwapTool | null = null;
  private _yieldProtocolRegistry: YieldProtocolRegistry | null = null;
  private _subgraphPrincipalProvider: SubgraphPrincipalProvider | null = null;
  private _yieldOptimizerUseCase: IYieldOptimizerUseCase | null = null;
  private _yieldPoolScanJob: YieldPoolScanJob | null = null;
  private _userIdleScanJob: UserIdleScanJob | null = null;
  private _yieldReportJob: YieldReportJob | null = null;
  private _loyaltyUseCase: ILoyaltyUseCase | null = null;
  private _recipientNotificationUseCase: RecipientNotificationUseCase | null =
    null;
  private _balanceProvider: IBalanceProvider | null = null;
  private _fallbackProvider: IBalanceProvider | null = null;
  private _ankrTransferHistory: ITransferHistoryProvider | null = null;
  private _transferHistoryCache: ITransferHistoryCache | null = null;
  private _transferHistoryUseCase: ITransferHistoryUseCase | null = null;
  private _yieldJobsNoStartWarned = {
    poolScan: false,
    idleScan: false,
    report: false,
  };
  private _predictionMarketProvider: IPredictionMarketProvider | null = null;
  private _predictionMarketClassifier: IPredictionMarketClassifier | null = null;
  private _predictionMarketBroadcaster: IPredictionMarketBroadcaster | null = null;
  private _predictionMarketDetector: IPredictionMarketDetector | null = null;
  private _predictionMarketVerifier: IPredictionMarketVerifier | null = null;
  private _predictionMarketFindingBroadcaster: IPredictionMarketFindingBroadcaster | null = null;
  private _predictionMarketScanUseCase: PredictionMarketScanUseCase | null = null;
  private _predictionMarketDeterministicCluster: PredictionMarketDeterministicClusterUseCase | null = null;
  private _predictionMarketDeterministicDetector: DeterministicPredictionMarketDetector | null = null;
  private _predictionMarketScanJob: PredictionMarketScanJob | null = null;
  private _predictionMarketNoStartWarned = false;
  private _polymarketAdapter: IPolymarketReadAdapter | null = null;
  private _predictionMarketBetUseCase: IPredictionMarketBetUseCase | null = null;
  private _predictionMarketReceiptBroadcaster: IPredictionMarketReceiptBroadcaster | null = null;
  private _polymarketPositionPollerJob: PolymarketPositionPollerJob | null = null;
  private _predictionMarketStuckBetSweeperJob: PredictionMarketStuckBetSweeperJob | null = null;
  private _predictionMarketExtractor: OpenRouterPredictionMarketExtractor | null = null;
  private _predictionMarketExtractFactsUseCase: PredictionMarketExtractFactsUseCase | null = null;
  private _predictionMarketExtractFactsJob: PredictionMarketExtractFactsJob | null = null;
  private _predictionMarketReviewHandler: PredictionMarketReviewHandler | null = null;
  private _predictionMarketExtractNoStartWarned = false;

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
      const intervalMs = parseInt(
        process.env.TOKEN_CRAWLER_INTERVAL_MS ?? String(15 * 60 * 1000),
        10,
      );
      const ingestionUseCase = new TokenIngestionUseCase(
        new PangolinTokenCrawler(),
        this.getSqlDB().tokenRegistry,
      );
      this._tokenCrawlerJob = new TokenCrawlerJob(
        ingestionUseCase,
        this.getChainId(),
        intervalMs,
      );
    }
    return this._tokenCrawlerJob;
  }

  getSolverRegistry(): SolverRegistry {
    if (!this._solverRegistry) {
      this._solverRegistry = new SolverRegistry(
        [],
        this.getSqlDB().toolManifests,
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
      this._toolIndexService = new PineconeToolIndexService(
        embeddingService,
        vectorStore,
      );
    }
    return this._toolIndexService;
  }

  /**
   * Result-card LLM interpreter. Returns undefined when
   * `RESULT_CARD_INTERPRETER_ENABLED` is not "true" or `OPENROUTER_API_KEY`
   * is unset — the renderer treats undefined as "interpreter off" and just
   * skips the optional italic note. Cache is best-effort: if Redis isn't
   * configured we run uncached.
   */
  getIntentInterpreter(): IIntentInterpreter | undefined {
    if (this._intentInterpreterChecked) {
      return this._intentInterpreter ?? undefined;
    }
    this._intentInterpreterChecked = true;
    const env = getResultCardEnv();
    if (!env.enabled || !env.available) return undefined;
    const redis = this.getRedis();
    const cache = redis ? makeRedisResponseCache(redis, "interp") : undefined;
    this._intentInterpreter = new OpenRouterIntentInterpreter({
      model: env.model,
      cache,
    });
    return this._intentInterpreter;
  }

  getSchemaCompiler(): OpenRouterSchemaCompiler {
    if (!this._schemaCompiler) {
      this._schemaCompiler = new OpenRouterSchemaCompiler();
    }
    return this._schemaCompiler;
  }

  getIntentUseCase(): IIntentUseCase {
    if (!this._intentUseCase) {
      const db = this.getSqlDB();
      this._intentUseCase = new IntentUseCaseImpl(
        this.getTokenRegistryService(),
        db.userProfiles,
        this.getSchemaCompiler(),
      );
    }
    return this._intentUseCase;
  }

  getUseCase(): IAssistantUseCase {
    if (!this.useCase) {
      const sqlDB = this.getSqlDB();

      const orchestrator = new OpenRouterOrchestrator(OPENROUTER_MODEL);

      const webSearchService = new TavilyWebSearchService(
        process.env.TAVILY_API_KEY ?? "",
        this.getRedis(),
      );

      const chainId = this.getChainId();
      const userProfileDB = sqlDB.userProfiles;
      const userProfileCache = this.getUserProfileCache();
      const balanceProvider = this.getBalanceProvider();
      const fallbackProvider = this.getFallbackProvider();

      const registryFactory = async (
        userId: string,
        conversationId: string,
        channelId: string,
      ): Promise<Map<string, ITool>> => {
        const r = new Map<string, ITool>();
        const add = (tool: ITool) => r.set(tool.definition().name, tool);

        add(new WebSearchTool(webSearchService));
        add(
          new GetPortfolioTool(
            userId,
            userProfileDB,
            balanceProvider,
            fallbackProvider,
            chainId,
            userProfileCache,
          ),
        );

        for (const tool of this.getSystemToolProvider().getTools(
          userId,
          conversationId,
        )) {
          add(tool);
        }

        // route_intent re-enters the capability dispatcher with a synthesized
        // slash command. Lazy-resolve to break the construction-time cycle:
        //   getCapabilityDispatcher → getUseCase (this factory) → getCapabilityDispatcher
        // (safe because this lambda runs per-message, after both are constructed).
        // route_intent is the unified NL → slash-command bridge: free-text
        // "swap …", "send …", "deposit into yield" all funnel back through
        // the same capability execution path as their /-prefixed counterparts.
        const dispatcher = await this.getCapabilityDispatcher();
        if (dispatcher) {
          add(
            new RouteIntentTool({
              userId,
              channelId,
              conversationId,
              dispatcher,
            }),
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
        db.userProfiles,
      );
    }
    return this._authUseCase;
  }

  getRedis(): Redis | undefined {
    const url = process.env.REDIS_URL;
    if (!url) return undefined;
    if (!this._redis) {
      this._redis = new Redis(url, { lazyConnect: false });
      this._redis.on("error", (err: Error) =>
        log.error({ err }, "Redis error"),
      );
      this._redis.on("ready", () => log.info("Redis ready"));
      metricsRegistry.bindRedis(this._redis);
      const _origSend = this._redis.sendCommand.bind(this._redis);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._redis as any).sendCommand = (cmd: any) => {
        const start = Date.now();
        const promise = _origSend(cmd);
        Promise.resolve(promise).finally(() =>
          metricsRegistry.recordRedisOp(Date.now() - start),
        );
        return promise;
      };
    }
    return this._redis;
  }

  getSessionDelegationCache(): ISessionDelegationCache | undefined {
    if (!this.getRedis()) return undefined;
    if (!this._sessionDelegationCache) {
      this._sessionDelegationCache = new RedisSessionDelegationCache(
        this.getRedis()!,
      );
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

  getSigningRequestUseCase(
    onResolved: (
      event: import("../../use-cases/interface/input/signingRequest.interface").SigningResolutionEvent,
    ) => void,
  ): ISigningRequestUseCase | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._signingRequestUseCase) {
      // Wrap the caller-supplied chat hook so bet-driven resolutions also
      // fan out to the bet use case. Order matters: chat notify runs first
      // so a slow bet-side state update can't delay user-visible UI.
      const composed = (
        event: import("../../use-cases/interface/input/signingRequest.interface").SigningResolutionEvent,
      ): void => {
        try {
          onResolved(event);
        } catch (err) {
          log.error({ err }, "onResolved (chat) threw");
        }
        if (!event.betId && !event.setupForUserId) return;
        const betUseCase = this.getPredictionMarketBetUseCase();
        if (!betUseCase) return;
        if (event.setupForUserId) {
          betUseCase
            .notifySetupSignResolved({
              userId: event.setupForUserId,
              requestId: event.requestId,
              kind: event.kind ?? "userop",
              purpose: event.purpose,
              txHash: event.txHash,
              rejected: event.rejected,
              errorCode: event.errorCode,
              errorMessage: event.errorMessage,
            })
            .catch((err) =>
              log.error({ err, userId: event.setupForUserId }, "notifySetupSignResolved threw"),
            );
          return;
        }
        betUseCase
          .notifySignResolved({
            betId: event.betId!,
            requestId: event.requestId,
            kind: event.kind ?? "userop",
            purpose: event.purpose,
            txHash: event.txHash,
            polymarketOrderId: event.polymarketOrderId,
            rejected: event.rejected,
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
          })
          .catch((err) => log.error({ err, betId: event.betId }, "notifySignResolved threw"));
      };
      this._signingRequestUseCase = new SigningRequestUseCaseImpl(
        new RedisSigningRequestCache(redis),
        composed,
        this.getTokenDelegationRepo(),
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

  getFallbackProvider(): IBalanceProvider {
    if (!this._fallbackProvider) {
      this._fallbackProvider = new RpcBalanceProvider(
        this.getViemClient(),
        this.getTokenRegistryService(),
      );
    }
    return this._fallbackProvider;
  }

  getBalanceProvider(): IBalanceProvider {
    if (!this._balanceProvider) {
      const ankrApiKey = process.env.ANKR_API_KEY;
      const portfolioProvider = process.env.PORTFOLIO_PROVIDER ?? "rpc";
      const chainId = this.getChainId();
      const hasAnkrChain = getAnkrBlockchain(chainId) != null;

      if (portfolioProvider === "ankr" && hasAnkrChain) {
        const ankr = new AnkrBalanceProvider({ apiKey: ankrApiKey });
        this._balanceProvider = new CachedBalanceProvider(ankr, 30_000);
      } else {
        this._balanceProvider = this.getFallbackProvider();
      }
    }
    return this._balanceProvider;
  }

  getPortfolioUseCase(): IPortfolioUseCase {
    if (!this._portfolioUseCase) {
      this._portfolioUseCase = new PortfolioUseCaseImpl(
        this.getSqlDB().userProfiles,
        this.getTokenRegistryService(),
        this.getBalanceProvider(),
        this.getFallbackProvider(),
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
        this.getWalletDataProvider(),
        this.getUserProfileCache(),
        this.getTransferHistoryUseCase(),
        this.getChainId(),
      );
    }
    return this._systemToolProvider;
  }

  getAnkrTransferHistoryProvider(): ITransferHistoryProvider {
    if (!this._ankrTransferHistory) {
      this._ankrTransferHistory = new AnkrTransferHistoryProvider({
        apiKey: process.env.ANKR_API_KEY,
      });
    }
    return this._ankrTransferHistory;
  }

  getTransferHistoryCache(): ITransferHistoryCache | undefined {
    const redis = this.getRedis();
    if (!redis) return undefined;
    if (!this._transferHistoryCache) {
      this._transferHistoryCache = new RedisTransferHistoryCache(redis);
    }
    return this._transferHistoryCache;
  }

  /**
   * Returns a single use-case instance whose internal provider factory binds
   * `userId` into a fresh CachedTransferHistoryProvider on each call. The
   * Ankr adapter and Redis cache are process-singletons; only the cached
   * decorator is per-user (so the per-user rate guard binds correctly).
   * Returns undefined if Ankr cannot serve the configured chain.
   */
  getTransferHistoryUseCase(): ITransferHistoryUseCase | undefined {
    if (this._transferHistoryUseCase) return this._transferHistoryUseCase;
    const chainId = this.getChainId();
    if (getAnkrBlockchain(chainId) == null) {
      log.warn(
        { chainId },
        "transfer-history disabled — chain not supported by Ankr",
      );
      return undefined;
    }
    const ankr = this.getAnkrTransferHistoryProvider();
    const cache = this.getTransferHistoryCache();
    const userProfileDB = this.getSqlDB().userProfiles;

    const cfg = {
      pageTtlSecRecent: TRANSFER_HISTORY_ENV.pageTtlSecRecent,
      pageTtlSecOlder: TRANSFER_HISTORY_ENV.pageTtlSecOlder,
      staleTtlSec: TRANSFER_HISTORY_ENV.staleTtlSec,
      perUserRpm: TRANSFER_HISTORY_ENV.perUserRpm,
      rpsGlobal: TRANSFER_HISTORY_ENV.rpsGlobal,
    };

    const factory = (userId: string): ITransferHistoryProvider => {
      // Without Redis we degrade to no-cache and no rate guard — at <1k DAU
      // this is safe; Ankr's own rate-limit will surface as adapter errors.
      if (!cache) return ankr;
      return new CachedTransferHistoryProvider(ankr, cache, userId, cfg);
    };

    this._transferHistoryUseCase = new TransferHistoryUseCaseImpl(
      userProfileDB,
      factory,
      chainId,
    );
    return this._transferHistoryUseCase;
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

  /**
   * Builds the capability dispatcher used by input adapters (Telegram first).
   * Returns undefined if no bot has been attached yet — capabilities that
   * need to render to Telegram require a live Bot reference.
   */
  async getCapabilityDispatcher(): Promise<ICapabilityDispatcher | undefined> {
    if (this._capabilityDispatcher) return this._capabilityDispatcher;
    const bot = this.getBot();
    if (!bot) return undefined;

    const registry = new CapabilityRegistry();
    const redisForPending = this.getRedis();
    const pending: IPendingCollectionStore = redisForPending
      ? new RedisPendingCollectionStore(redisForPending)
      : new InMemoryPendingCollectionStore();
    // Renderer needs signingRequestUseCase so that `sign_calldata` artifacts
    // (emitted by sendCapability and other one-shot tx flows) persist BOTH
    // the miniAppRequest and the signingRequest record. Without the latter,
    // POST /response 404s on signingRequestCache miss, the miniAppRequest is
    // never cleaned up, and the FE polls forever.
    // Use the already-initialized instance (created by *Cli.ts at startup
    // with the real onResolved callback). Fall back to undefined only when
    // Redis isn't configured — same policy as the swap capability above.
    const renderer = new TelegramArtifactRenderer(
      bot,
      this.getMiniAppRequestCache(),
      this._signingRequestUseCase ?? undefined,
      this.getIntentInterpreter(),
    );
    const sqlDB = this.getSqlDB();

    // Register capabilities here. Order does not matter.
    registry.register(
      new BuyCapability(sqlDB.userProfiles, this.getChainId()),
    );

    const sendDeps = {
      intentUseCase: this.getIntentUseCase(),
      resolverEngine: this.getResolverEngine(),
      tokenRegistryService: this.getTokenRegistryService(),
      tokenDelegationDB: this.getTokenDelegationRepo(),
      telegramHandleResolver: this.getTelegramHandleResolver(),
      privyAuthService: this.getPrivyAuthService(),
      userProfileRepo: sqlDB.userProfiles,
      pendingDelegationRepo: sqlDB.pendingDelegations,
      delegationBuilder: this.getDelegationRequestBuilder(),
      chainId: this.getChainId(),
      loyaltyUseCase: this.getLoyaltyUseCase(),
      pendingIntentStore: this.getPendingIntentStore(),
    };

    // One SendCapability instance per INTENT_COMMAND (except BUY and SWAP,
    // which own their own dedicated capabilities). All share the same deps +
    // compile→resolve→sign pipeline; the command is just a trigger.
    for (const command of Object.values(INTENT_COMMAND)) {
      if (command === INTENT_COMMAND.BUY) continue;
      if (command === INTENT_COMMAND.SWAP) continue;
      if (command === INTENT_COMMAND.YIELD) continue;
      if (command === INTENT_COMMAND.WITHDRAW) continue; // owned by YieldCapability
      if (command === INTENT_COMMAND.POINTS) continue;
      if (command === INTENT_COMMAND.LEADERBOARD) continue;
      // /topup is conceptually an onramp, not a transfer. Routing it through
      // SendCapability's compile→resolve pipeline causes the LLM extractor to
      // ask transfer-style questions ("Who should I send the USDC to?"). The
      // user-facing onramp lives at /buy. Until a dedicated topup capability
      // exists (or /topup becomes an alias for /buy), keep it unbound here.
      if (command === INTENT_COMMAND.TOPUP) continue;
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
          miniAppRequestCache: this.getMiniAppRequestCache(),
          pendingIntentStore: this.getPendingIntentStore(),
          tokenDelegationDB: this.getTokenDelegationRepo(),
          userProfileRepo: sqlDB.userProfiles,
          chainId: this.getChainId(),
          loyaltyUseCase: this.getLoyaltyUseCase(),
        }),
      );
    } else {
      log.warn(
        { reason: "redis_unavailable" },
        "/swap capability skipped — signing-request use case not ready",
      );
    }

    const yieldOptimizer = this.getYieldOptimizerUseCase();
    if (yieldOptimizer) {
      registry.register(
        new YieldCapability({
          optimizer: yieldOptimizer,
          miniAppRequestCache: this.getMiniAppRequestCache(),
          signingRequestUseCase: this._signingRequestUseCase ?? undefined,
          loyaltyUseCase: this.getLoyaltyUseCase(),
        }),
      );
    } else {
      log.warn({ reason: "redis_unavailable" }, "/yield capability skipped");
    }

    registry.register(
      new LoyaltyCapability({
        loyaltyUseCase: this.getLoyaltyUseCase(),
        leaderboardDefaultLimit: LOYALTY_ENV.leaderboardDefaultLimit,
      }),
    );

    const betUseCase = this.getPredictionMarketBetUseCase();
    if (betUseCase) {
      registry.register(
        new PlaceBetCapability(betUseCase, this.getPredictionMarketRepo()),
      );
      registry.register(new ClosePositionCapability(betUseCase));
    } else {
      log.info(
        { reason: "bet-use-case-unavailable" },
        "place_bet/close_position capabilities skipped",
      );
    }

    // Free-text fallback: the LLM loop. Handles anything that isn't a slash
    // command and isn't continuing a pending capability flow.
    registry.registerDefault(new AssistantChatCapability(this.getUseCase()));

    this._capabilityDispatcher = new CapabilityDispatcher(
      registry,
      renderer,
      pending,
      this._signingRequestUseCase ?? undefined,
      this.getMiniAppRequestCache(),
    );
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

  getSubgraphPrincipalProvider(): SubgraphPrincipalProvider {
    if (!this._subgraphPrincipalProvider) {
      this._subgraphPrincipalProvider = new SubgraphPrincipalProvider(
        YIELD_ENV.theGraphApiKey,
      );
    }
    return this._subgraphPrincipalProvider;
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

      const sendRebalanceNudge = async (
        _userId: string,
        chatId: string,
        params: {
          chainId: number;
          tokenAddress: string;
          tokenSymbol: string;
          fromProtocol: YIELD_PROTOCOL_ID;
          toProtocol: YIELD_PROTOCOL_ID;
          currentApy: number;
          newApy: number;
          balanceHuman: string;
        },
      ): Promise<void> => {
        if (!bot) return;
        const fromApyPct = (params.currentApy * 100).toFixed(2);
        const toApyPct = (params.newApy * 100).toFixed(2);
        const text =
          `🔄 Better yield available — your ${params.balanceHuman} ${params.tokenSymbol} is ` +
          `earning ~${fromApyPct}% APY on ${params.fromProtocol}, but ${params.toProtocol} ` +
          `is now offering ~${toApyPct}%. Want me to move it?`;
        await bot.api.sendMessage(Number(chatId), text, {
          reply_markup: buildRebalanceNudgeKeyboard({
            chainId: params.chainId,
            tokenAddress: params.tokenAddress,
            fromProtocol: params.fromProtocol,
            toProtocol: params.toProtocol,
          }),
        });
      };

      const protocolRegistry = this.getYieldProtocolRegistry();
      this._yieldOptimizerUseCase = new YieldOptimizerUseCase({
        protocolRegistry,
        ranker: new YieldPoolRanker(),
        yieldRepo: this.getYieldRepo(),
        userProfileRepo: sqlDB.userProfiles,
        chainReader: this.getViemClient(),
        redis,
        nudgeCooldownSec: YIELD_ENV.nudgeCooldownSec,
        idleThresholdUsd: YIELD_ENV.idleUsdcThresholdUsd,
        // Sticky-winner TTL = 4× pool scan interval (auto-resets if scans stop).
        winnerStreakTtlSec: Math.max(60, Math.floor((YIELD_ENV.poolScanIntervalMs * 4) / 1000)),
        rebalanceStickyScans: YIELD_ENV.rebalanceStickyScans,
        rebalanceMinDeltaBps: YIELD_ENV.rebalanceMinDeltaBps,
        rebalanceNudgeCooldownSec: YIELD_ENV.rebalanceNudgeCooldownSec,
        principalProvider: this.getSubgraphPrincipalProvider(),
        positionDiscovery: new OnChainPositionDiscovery({ protocolRegistry }),
        sendNudge,
        sendRebalanceNudge,
      });
    }
    return this._yieldOptimizerUseCase;
  }

  getYieldPoolScanJob(): YieldPoolScanJob | undefined {
    const optimizer = this.getYieldOptimizerUseCase();
    if (!optimizer) {
      if (!this._yieldJobsNoStartWarned.poolScan) {
        this._yieldJobsNoStartWarned.poolScan = true;
        log.warn(
          { feature: "yield", reason: "redis-missing" },
          "yieldPoolScanJob not started",
        );
      }
      return undefined;
    }
    if (!this._yieldPoolScanJob) {
      this._yieldPoolScanJob = new YieldPoolScanJob(
        optimizer,
        YIELD_ENV.poolScanIntervalMs,
      );
    }
    return this._yieldPoolScanJob;
  }

  getUserIdleScanJob(): UserIdleScanJob | undefined {
    const optimizer = this.getYieldOptimizerUseCase();
    if (!optimizer) {
      if (!this._yieldJobsNoStartWarned.idleScan) {
        this._yieldJobsNoStartWarned.idleScan = true;
        log.warn(
          { feature: "yield", reason: "redis-missing" },
          "userIdleScanJob not started",
        );
      }
      return undefined;
    }
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
    if (!optimizer || !redis) {
      if (!this._yieldJobsNoStartWarned.report) {
        this._yieldJobsNoStartWarned.report = true;
        log.warn(
          { feature: "yield", reason: "redis-missing" },
          "yieldReportJob not started",
        );
      }
      return undefined;
    }
    if (!this._yieldReportJob) {
      const sqlDB = this.getSqlDB();
      const bot = this.getBot();

      const interpreter = this.getIntentInterpreter();

      const sendReport = async (
        _userId: string,
        chatId: string,
        report: DailyReport,
      ): Promise<void> => {
        if (!bot) return;
        const start = Date.now();
        log.info(
          { step: "started", userId: _userId, chatId, positions: report.positions.length },
          "yield-report-send",
        );

        type PositionSummary = {
          protocol: string;
          symbol: string;
          balance: string;
          delta: string;
          deltaPrefix: string;
          deltaNum: number;
        };
        const summaries: PositionSummary[] = [];
        for (const pos of report.positions) {
          const yieldCfg = getYieldConfig(pos.chainId);
          const stable = yieldCfg?.stablecoins.find(
            (s) => s.address.toLowerCase() === pos.tokenAddress.toLowerCase(),
          );
          if (!stable) continue;
          const { decimals, symbol } = stable;
          const deltaNum = Number(pos.delta24hRaw) / Math.pow(10, decimals);
          const balance = (
            Number(pos.balanceRaw) / Math.pow(10, decimals)
          ).toFixed(4);
          const delta = deltaNum.toFixed(4);
          const deltaPrefix = deltaNum >= 0 ? "+" : "";
          summaries.push({
            protocol: pos.protocolId,
            symbol,
            balance,
            delta,
            deltaPrefix,
            deltaNum,
          });
        }

        if (summaries.length === 0) {
          log.info(
            { step: "succeeded", mode: "skipped-no-stable-positions", chatId, durationMs: Date.now() - start },
            "yield-report-send",
          );
          return;
        }

        // Top mover by absolute earnings.
        const top = [...summaries].sort(
          (a, b) => Math.abs(b.deltaNum) - Math.abs(a.deltaNum),
        )[0]!;
        const totalEarned = summaries.reduce((s, x) => s + x.deltaNum, 0);
        const totalEarnedStr = `${totalEarned >= 0 ? "+" : ""}${totalEarned.toFixed(4)}`;

        const fields: ResultField[] = [
          {
            label: "Earned today",
            value: `${totalEarnedStr} (across ${summaries.length} position${summaries.length === 1 ? "" : "s"})`,
            emphasis: "primary",
          },
          {
            label: "Top mover",
            value: `${top.protocol} ${top.deltaPrefix}${top.delta} ${top.symbol}`,
          },
        ];

        const details: ResultField[] = summaries.map((s) => ({
          label: s.protocol,
          value: `${s.deltaPrefix}${s.delta} ${s.symbol} today · ${s.balance} total`,
        }));

        const result: IntentResult = {
          status: "success",
          verb: "portfolio_summary",
          headline: "Your yield update",
          fields,
          details,
          complexity: "complex",
          interpreterContext: {
            totalEarned: totalEarnedStr,
            positions: summaries.map((s) => ({
              protocol: s.protocol,
              symbol: s.symbol,
              balance: s.balance,
              delta: `${s.deltaPrefix}${s.delta}`,
            })),
          },
          nextActions: [
            { label: "Check positions", kind: "command", payload: "/yield" },
          ],
        };

        let interpreterNote: string | null = null;
        if (interpreter) {
          try {
            interpreterNote = await interpreter.interpret({
              verb: result.verb,
              status: result.status,
              fields: result.fields,
              interpreterContext: result.interpreterContext,
            });
          } catch {
            interpreterNote = null;
          }
        }

        const rendered = renderResultCard({ result, interpreterNote });
        try {
          await bot.api.sendMessage(Number(chatId), rendered.text, {
            parse_mode: rendered.parseMode,
            ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
          });
          log.info(
            {
              step: "succeeded",
              mode: "rendered",
              chatId,
              positions: summaries.length,
              hasInterpreterNote: !!interpreterNote,
              durationMs: Date.now() - start,
            },
            "yield-report-send",
          );
        } catch (err) {
          log.warn(
            { step: "failed", mode: "markdownV2-retry-plain", err, chatId },
            "yield-report-send",
          );
          const plain =
            `${result.headline}\n` +
            result.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
          await bot.api.sendMessage(Number(chatId), plain, {
            ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
          });
          log.info(
            {
              step: "succeeded",
              mode: "plain-fallback",
              chatId,
              positions: summaries.length,
              durationMs: Date.now() - start,
            },
            "yield-report-send",
          );
        }
      };

      this._yieldReportJob = new YieldReportJob(
        optimizer,
        this.getYieldRepo(),
        redis,
        YIELD_ENV.reportUtcHour,
        YIELD_ENV.reportIntervalMs,
        sendReport,
        async (userId) => {
          const session = await sqlDB.telegramSessions.findByUserId(userId);
          return session?.telegramChatId ?? null;
        },
        () => sqlDB.telegramSessions.listActiveUserIds(),
      );
    }
    return this._yieldReportJob;
  }

  getLoyaltyUseCase(): ILoyaltyUseCase {
    if (!this._loyaltyUseCase) {
      this._loyaltyUseCase = new LoyaltyUseCaseImpl({
        repo: this.getSqlDB().loyaltyRepo,
        redis: this.getRedis(),
        activeSeasonCacheTtlMs: LOYALTY_ENV.activeSeasonCacheTtlMs,
        leaderboardCacheTtlMs: LOYALTY_ENV.leaderboardCacheTtlMs,
      });
    }
    return this._loyaltyUseCase;
  }

  getRecipientNotificationUseCase(
    send: (chatId: number, text: string, opts?: object) => Promise<void>,
  ): RecipientNotificationUseCase {
    if (!this._recipientNotificationUseCase) {
      this._recipientNotificationUseCase = new RecipientNotificationUseCase(
        this.getSqlDB().recipientNotifications,
        this.getSqlDB().telegramSessions,
        send,
      );
    }
    return this._recipientNotificationUseCase;
  }

  getPendingIntentStore(): IPendingIntentStore | undefined {
    if (this._pendingIntentStore) return this._pendingIntentStore;
    const redis = this.getRedis();
    if (!redis) return undefined;
    this._pendingIntentStore = new RedisPendingIntentStore(redis);
    return this._pendingIntentStore;
  }

  getPredictionMarketProvider(): IPredictionMarketProvider {
    if (!this._predictionMarketProvider) {
      this._predictionMarketProvider = new PolymarketProvider();
    }
    return this._predictionMarketProvider;
  }

  getPredictionMarketRepo(): IPredictionMarketRepository {
    return this.getSqlDB().predictionMarkets;
  }

  getPredictionMarketClassifier(): IPredictionMarketClassifier | undefined {
    if (this._predictionMarketClassifier) return this._predictionMarketClassifier;
    if (!isOpenRouterConfigured()) return undefined;
    const redis = this.getRedis();
    const cache = redis ? makeRedisResponseCache(redis, "pm-cluster") : undefined;
    this._predictionMarketClassifier = new OpenRouterPredictionMarketClassifier({
      model: PREDICTION_MARKETS_ENV.classifierModel,
      cache,
      maxCriteriaChars: PREDICTION_MARKETS_ENV.maxCriteriaChars,
      promptVersion: PREDICTION_MARKETS_ENV.promptVersion,
      cacheTtlSec: PREDICTION_MARKETS_ENV.clusterCacheTtlSec,
      reasoningEffort: PREDICTION_MARKETS_ENV.classifierReasoningEffort,
      maxTokens: PREDICTION_MARKETS_ENV.classifierMaxTokens,
    });
    return this._predictionMarketClassifier;
  }

  getPredictionMarketBroadcaster(): IPredictionMarketBroadcaster | undefined {
    if (this._predictionMarketBroadcaster) return this._predictionMarketBroadcaster;
    const redis = this.getRedis();
    const bot = this.getBot();
    if (!redis || !bot) return undefined;
    const sqlDB = this.getSqlDB();
    this._predictionMarketBroadcaster = new PredictionMarketBroadcaster({
      tgApi: bot.api,
      redis,
      listActiveUserIds: () => sqlDB.telegramSessions.listActiveUserIds(),
      getChatId: async (userId) => {
        const session = await sqlDB.telegramSessions.findByUserId(userId);
        return session?.telegramChatId ?? null;
      },
      concurrency: PREDICTION_MARKETS_ENV.broadcastConcurrency,
    });
    return this._predictionMarketBroadcaster;
  }

  getPredictionMarketDetector(): IPredictionMarketDetector | undefined {
    if (this._predictionMarketDetector) return this._predictionMarketDetector;
    if (!isOpenRouterConfigured()) return undefined;
    const redis = this.getRedis();
    const cache = redis ? makeRedisResponseCache(redis, "pm-detect") : undefined;
    this._predictionMarketDetector = new OpenRouterPredictionMarketDetector({
      model: PREDICTION_MARKETS_ENV.detectorModel,
      cache,
      promptVersion: PREDICTION_MARKETS_ENV.promptVersion,
      cacheTtlSec: PREDICTION_MARKETS_ENV.detectorCacheTtlSec,
      priceBucketBps: PREDICTION_MARKETS_ENV.detectorPriceBucketBps,
      reasoningEffort: PREDICTION_MARKETS_ENV.detectorReasoningEffort,
      maxTokens: PREDICTION_MARKETS_ENV.detectorMaxTokens,
    });
    return this._predictionMarketDetector;
  }

  getPredictionMarketVerifier(): IPredictionMarketVerifier {
    if (this._predictionMarketVerifier) return this._predictionMarketVerifier;
    // The sizer's resolver delegates to `provider.getOutcomeTokens`, which is
    // populated as a side effect of every `fetchFiltered` / `fetchByIds` call
    // (parses Gamma's `clobTokenIds`). Cold-start ticks may miss until the
    // first fetch lands; the verifier logs `sizing-skipped: tokens-missing`
    // and the finding survives un-sized.
    const provider = this.getPredictionMarketProvider();
    this._predictionMarketVerifier = new PredictionMarketVerifier({
      provider,
      verifyFreshnessMs: PREDICTION_MARKETS_ENV.verifyFreshnessMs,
      oddsDriftToleranceBps: PREDICTION_MARKETS_ENV.oddsDriftToleranceBps,
      minGapBps: PREDICTION_MARKETS_ENV.minGapBps,
      minSumDeviationBps: PREDICTION_MARKETS_ENV.minSumDeviationBps,
      findingMinLiquidityUsd: PREDICTION_MARKETS_ENV.findingMinLiquidityUsd,
      sizing: PREDICTION_MARKETS_ENV.sizingEnabled
        ? {
            sizer: new AnalyticalPredictionMarketSizer(),
            polymarket: this.getPolymarketAdapter(),
            outcomeTokenIdResolver: (marketId) => provider.getOutcomeTokens(marketId),
            budgetUsdc: PREDICTION_MARKETS_ENV.sizerBudgetUsdc,
            feeBps: PREDICTION_MARKETS_ENV.sizerFeeBps,
            gasEstimateUsdc: PREDICTION_MARKETS_ENV.sizerGasEstimateUsdc,
            depthLevels: PREDICTION_MARKETS_ENV.sizerDepthLevels,
          }
        : undefined,
    });
    return this._predictionMarketVerifier;
  }

  getPredictionMarketFindingBroadcaster():
    | IPredictionMarketFindingBroadcaster
    | undefined {
    if (this._predictionMarketFindingBroadcaster) return this._predictionMarketFindingBroadcaster;
    const redis = this.getRedis();
    const bot = this.getBot();
    if (!redis || !bot) return undefined;
    const sqlDB = this.getSqlDB();
    this._predictionMarketFindingBroadcaster = new PredictionMarketFindingBroadcaster({
      tgApi: bot.api,
      redis,
      listActiveUserIds: () => sqlDB.telegramSessions.listActiveUserIds(),
      getChatId: async (userId) => {
        const session = await sqlDB.telegramSessions.findByUserId(userId);
        return session?.telegramChatId ?? null;
      },
      concurrency: PREDICTION_MARKETS_ENV.broadcastConcurrency,
      affiliateParam: PREDICTION_MARKETS_ENV.polymarketAffiliateParam,
    });
    return this._predictionMarketFindingBroadcaster;
  }

  getPredictionMarketScanUseCase(): PredictionMarketScanUseCase | undefined {
    if (this._predictionMarketScanUseCase) return this._predictionMarketScanUseCase;
    const classifier = this.getPredictionMarketClassifier();
    if (!classifier) return undefined;
    // Cluster broadcast intentionally disabled — users only receive the
    // asymmetric-pattern (finding) message, not the cluster-found brief.
    const broadcaster = null;
    const detector = PREDICTION_MARKETS_ENV.findingsEnabled
      ? this.getPredictionMarketDetector() ?? null
      : null;
    const verifier = PREDICTION_MARKETS_ENV.findingsEnabled
      ? this.getPredictionMarketVerifier()
      : null;
    const findingBroadcaster = PREDICTION_MARKETS_ENV.findingsEnabled
      ? this.getPredictionMarketFindingBroadcaster() ?? null
      : null;
    this._predictionMarketScanUseCase = new PredictionMarketScanUseCase(
      this.getPredictionMarketProvider(),
      classifier,
      this.getPredictionMarketRepo(),
      broadcaster,
      detector,
      verifier,
      findingBroadcaster,
      this.getPredictionMarketDeterministicCluster(),
      PREDICTION_MARKETS_ENV.findingsEnabled ? this.getPredictionMarketDeterministicDetector() : null,
      this.getSqlDB().predictionMarketFacts,
    );
    return this._predictionMarketScanUseCase;
  }

  getPredictionMarketDeterministicCluster(): PredictionMarketDeterministicClusterUseCase {
    if (!this._predictionMarketDeterministicCluster) {
      this._predictionMarketDeterministicCluster =
        new PredictionMarketDeterministicClusterUseCase(this.getSqlDB().predictionMarketFacts);
    }
    return this._predictionMarketDeterministicCluster;
  }

  getPredictionMarketDeterministicDetector(): DeterministicPredictionMarketDetector {
    if (!this._predictionMarketDeterministicDetector) {
      this._predictionMarketDeterministicDetector = new DeterministicPredictionMarketDetector(
        this.getSqlDB().predictionMarketFacts,
        {
          tolBps: PREDICTION_MARKETS_ENV.minGapBps,
          highConfidenceLiquidityUsd: PREDICTION_MARKETS_ENV.findingMinLiquidityUsd * 4,
          highConfidenceMagnitudeBps: 500,
        },
      );
    }
    return this._predictionMarketDeterministicDetector;
  }

  getPredictionMarketScanJob(): PredictionMarketScanJob | undefined {
    if (!PREDICTION_MARKETS_ENV.enabled) {
      if (!this._predictionMarketNoStartWarned) {
        this._predictionMarketNoStartWarned = true;
        log.info(
          { feature: "predictionMarket", reason: "disabled" },
          "predictionMarketScanJob not started — set PREDICTION_MARKETS_ENABLED=true to enable",
        );
      }
      return undefined;
    }
    const useCase = this.getPredictionMarketScanUseCase();
    const redis = this.getRedis();
    if (!useCase || !redis) {
      if (!this._predictionMarketNoStartWarned) {
        this._predictionMarketNoStartWarned = true;
        log.warn(
          { feature: "predictionMarket", reason: "redis-or-classifier-missing" },
          "predictionMarketScanJob not started",
        );
      }
      return undefined;
    }
    if (!this._predictionMarketScanJob) {
      this._predictionMarketScanJob = new PredictionMarketScanJob(
        useCase,
        redis,
        PREDICTION_MARKETS_ENV.fetchIntervalMs,
      );
    }
    return this._predictionMarketScanJob;
  }

  getPredictionMarketBetRepo(): IPredictionMarketBetRepository {
    return this.getSqlDB().predictionMarketBets;
  }

  getPredictionMarketExtractor(): OpenRouterPredictionMarketExtractor | undefined {
    if (this._predictionMarketExtractor) return this._predictionMarketExtractor;
    if (!isOpenRouterConfigured()) return undefined;
    this._predictionMarketExtractor = new OpenRouterPredictionMarketExtractor({
      model: PREDICTION_MARKETS_ENV.extractorModel,
      promptVersion: PREDICTION_MARKETS_ENV.extractorPromptVersion,
    });
    return this._predictionMarketExtractor;
  }

  getPredictionMarketReviewHandler(): PredictionMarketReviewHandler | undefined {
    if (!PREDICTION_MARKETS_ENV.reviewAdminChatId) return undefined;
    if (this._predictionMarketReviewHandler) return this._predictionMarketReviewHandler;
    this._predictionMarketReviewHandler = new PredictionMarketReviewHandler(
      this.getSqlDB().predictionMarketFacts,
      PREDICTION_MARKETS_ENV.reviewAdminChatId,
    );
    return this._predictionMarketReviewHandler;
  }

  getPredictionMarketExtractFactsUseCase(): PredictionMarketExtractFactsUseCase | undefined {
    if (this._predictionMarketExtractFactsUseCase) {
      return this._predictionMarketExtractFactsUseCase;
    }
    const extractor = this.getPredictionMarketExtractor();
    if (!extractor) return undefined;
    const bot = this.getBot();
    const reviewHandler = this.getPredictionMarketReviewHandler();
    const notifier = bot && reviewHandler ? reviewHandler.notifier(bot.api) : undefined;
    this._predictionMarketExtractFactsUseCase = new PredictionMarketExtractFactsUseCase(
      extractor,
      this.getSqlDB().predictionMarketFacts,
      { concurrency: PREDICTION_MARKETS_ENV.extractorConcurrency },
      notifier,
    );
    return this._predictionMarketExtractFactsUseCase;
  }

  getPredictionMarketExtractFactsJob(): PredictionMarketExtractFactsJob | undefined {
    if (!PREDICTION_MARKETS_ENV.enabled) {
      if (!this._predictionMarketExtractNoStartWarned) {
        this._predictionMarketExtractNoStartWarned = true;
        log.info(
          { feature: "predictionMarketExtractFacts", reason: "disabled" },
          "extract-facts job not started — set PREDICTION_MARKETS_ENABLED=true",
        );
      }
      return undefined;
    }
    const useCase = this.getPredictionMarketExtractFactsUseCase();
    const redis = this.getRedis();
    if (!useCase || !redis) {
      if (!this._predictionMarketExtractNoStartWarned) {
        this._predictionMarketExtractNoStartWarned = true;
        log.warn(
          { feature: "predictionMarketExtractFacts", reason: "deps-missing" },
          "extract-facts job not started",
        );
      }
      return undefined;
    }
    if (!this._predictionMarketExtractFactsJob) {
      this._predictionMarketExtractFactsJob = new PredictionMarketExtractFactsJob(
        useCase,
        this.getPredictionMarketRepo(),
        redis,
        PREDICTION_MARKETS_ENV.extractFactsIntervalMs,
      );
    }
    return this._predictionMarketExtractFactsJob;
  }


  getPredictionMarketBetUseCase(): IPredictionMarketBetUseCase | undefined {
    if (this._predictionMarketBetUseCase) return this._predictionMarketBetUseCase;
    if (!PREDICTION_MARKETS_ENV.betsEnabled) {
      log.info(
        { feature: "predictionMarketBets", reason: "disabled" },
        "betUseCase not built — set PREDICTION_MARKETS_BETS_ENABLED=true to enable",
      );
      return undefined;
    }
    // Sign-queue deps. Wired when redis + the mini-app request cache are
    // available; otherwise the bet use case constructs in a no-op shape and
    // advance()/notifySignResolved log + exit.
    const redis = this.getRedis();
    const miniAppRequestCache = this.getMiniAppRequestCache();
    const sqlDB = this.getSqlDB();
    const signQueueDeps =
      redis && miniAppRequestCache
        ? {
            // Lazy getter breaks the circular dep with signingRequestUseCase
            // (whose onResolved wrapper resolves the bet use case).
            getSigningRequestUseCase: () => this._signingRequestUseCase ?? undefined,
            miniAppRequestCache,
            redis,
            chatIdResolver: async (userId: string) => {
              const session = await sqlDB.telegramSessions.findByUserId(userId);
              const chatId = session?.telegramChatId;
              if (!chatId) return null;
              const n = Number(chatId);
              return Number.isFinite(n) ? n : null;
            },
            // Optional; used by `enqueueOrderSign` to push a `bet_drift` chat
            // card when a queue-driven bet is rejected for price drift before
            // signing. Undefined when the bot hasn't started yet (rare —
            // off-path startup); the use case falls back to log-only.
            receiptBroadcaster: this.getPredictionMarketReceiptBroadcaster(),
          }
        : undefined;
    this._predictionMarketBetUseCase = new PredictionMarketBetUseCase(
      this.getPredictionMarketBetRepo(),
      this.getSqlDB().userProfiles,
      this.getPolymarketAdapter(),
      this.getPredictionMarketRepo(),
      signQueueDeps,
    );
    return this._predictionMarketBetUseCase;
  }

  getPredictionMarketStuckBetSweeperJob(): PredictionMarketStuckBetSweeperJob | undefined {
    if (this._predictionMarketStuckBetSweeperJob) return this._predictionMarketStuckBetSweeperJob;
    const useCase = this.getPredictionMarketBetUseCase();
    const redis = this.getRedis();
    if (!useCase || !redis) {
      log.warn(
        { feature: "predictionMarketBets", reason: "deps-missing" },
        "stuckBetSweeper not started",
      );
      return undefined;
    }
    this._predictionMarketStuckBetSweeperJob = new PredictionMarketStuckBetSweeperJob({
      betUseCase: useCase,
      redis,
      intervalMs: PREDICTION_MARKETS_ENV.stuckBetSweepIntervalMs,
      stuckTimeoutMs: PREDICTION_MARKETS_ENV.stuckBetTimeoutMs,
    });
    return this._predictionMarketStuckBetSweeperJob;
  }

  getPolymarketAdapter(): IPolymarketReadAdapter {
    if (!this._polymarketAdapter) {
      this._polymarketAdapter = new PolymarketAdapter(PREDICTION_MARKETS_ENV.clobApiBase);
    }
    return this._polymarketAdapter;
  }

  getPredictionMarketReceiptBroadcaster(): IPredictionMarketReceiptBroadcaster | undefined {
    if (this._predictionMarketReceiptBroadcaster) return this._predictionMarketReceiptBroadcaster;
    const bot = this.getBot();
    if (!bot) return undefined;
    const sqlDB = this.getSqlDB();
    this._predictionMarketReceiptBroadcaster = new PredictionMarketReceiptBroadcaster({
      tgApi: bot.api,
      getChatId: async (userId) => {
        const session = await sqlDB.telegramSessions.findByUserId(userId);
        return session?.telegramChatId ?? null;
      },
      affiliateParam: PREDICTION_MARKETS_ENV.polymarketAffiliateParam,
    });
    return this._predictionMarketReceiptBroadcaster;
  }

  getPolymarketPositionPollerJob(): PolymarketPositionPollerJob | undefined {
    if (this._polymarketPositionPollerJob) return this._polymarketPositionPollerJob;
    if (!PREDICTION_MARKETS_ENV.betsEnabled) return undefined;
    const useCase = this.getPredictionMarketBetUseCase();
    const broadcaster = this.getPredictionMarketReceiptBroadcaster();
    const redis = this.getRedis();
    if (!useCase || !broadcaster || !redis) {
      log.warn(
        { feature: "predictionMarketBets", reason: "deps-missing" },
        "polymarketPositionPollerJob not started",
      );
      return undefined;
    }
    this._polymarketPositionPollerJob = new PolymarketPositionPollerJob({
      betUseCase: useCase,
      betRepo: this.getPredictionMarketBetRepo(),
      receiptBroadcaster: broadcaster,
      redis,
      intervalMs: PREDICTION_MARKETS_ENV.positionPollIntervalMs,
      concurrency: PREDICTION_MARKETS_ENV.broadcastConcurrency,
    });
    return this._polymarketPositionPollerJob;
  }

  getHttpApiServer(
    signingRequestUseCase?: ISigningRequestUseCase,
  ): HttpApiServer {
    const port = parseInt(process.env.HTTP_API_PORT ?? "4000", 10);
    return new HttpApiServer(
      this.getAuthUseCase(),
      port,
      this.getIntentUseCase(),
      this.getPortfolioUseCase(),
      this.getSessionDelegationUseCase(),
      this.getSqlDB().pendingDelegations,
      this.getMiniAppRequestCache(),
      signingRequestUseCase,
      this.getUserProfileCache(),
      this.getSqlDB().userPreferences,
      this.getTokenDelegationRepo(),
      this.getSqlDB().userProfiles,
      this.getSqlDB().telegramSessions,
      this.getTelegramNotifier(),
      this.getYieldOptimizerUseCase(),
      this.getLoyaltyUseCase(),
      this.getSqlDB().users,
      this.getTransferHistoryUseCase(),
      this.getSubgraphPrincipalProvider(),
      this.getPendingIntentStore(),
      () => this.getCapabilityDispatcher(),
      this.getPredictionMarketBetUseCase(),
      this.getPolymarketAdapter(),
      this.getPredictionMarketRepo(),
      new PimlicoBundlerProxy(),
    );
  }

}
