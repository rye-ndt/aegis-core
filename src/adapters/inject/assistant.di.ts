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
import { OPENAI_MODEL } from "../../helpers/env/openaiEnv";
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
import { TokenCrawlerJob } from "../implementations/input/jobs/tokenCrawlerJob";
import { UserIdleScanJob } from "../implementations/input/jobs/userIdleScanJob";
import { YieldPoolScanJob } from "../implementations/input/jobs/yieldPoolScanJob";
import { YieldReportJob } from "../implementations/input/jobs/yieldReportJob";
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
import { PositionsCapability } from "../implementations/output/capabilities/positionsCapability";
import { BuyCapability } from "../implementations/output/capabilities/buyCapability";
import { LoyaltyCapability } from "../implementations/output/capabilities/loyaltyCapability";
import { SendCapability } from "../implementations/output/capabilities/sendCapability";
import { StockCapability } from "../implementations/output/capabilities/stockCapability";
import { SwapCapability } from "../implementations/output/capabilities/swapCapability";
import { StockUseCaseImpl } from "../../use-cases/implementations/stock.usecase";
import { RelayCrossChainSwapPlanner } from "../implementations/output/stocks/relayCrossChainSwapPlanner";
import {
  AsterPositionsProvider,
  CachedStockPositionsProvider,
} from "../implementations/output/aster/asterPositionsProvider";
import type { IStockUseCase } from "../../use-cases/interface/input/stock.interface";
import type { IStockPositionsProvider } from "../../use-cases/interface/output/stocks/stockPositionsProvider.interface";
import type { ICrossChainSwapPlanner } from "../../use-cases/interface/output/stocks/crossChainSwapPlanner.interface";
import {
  YieldCapability,
  buildNudgeKeyboard,
  buildRebalanceNudgeKeyboard,
} from "../implementations/output/capabilities/yieldCapability";
import { DelegationRequestBuilder } from "../implementations/output/delegation/delegationRequestBuilder";
import { OpenAIEmbeddingService } from "../implementations/output/embedding/openai";
import { OpenAISchemaCompiler } from "../implementations/output/intentParser/openai.schemaCompiler";
import { OpenAIOrchestrator } from "../implementations/output/orchestrator/openai";
import { OpenAIIntentInterpreter } from "../implementations/output/intentInterpreter/openai.intentInterpreter";
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
import { StockOpenTool } from "../implementations/output/tools/stockOpen.tool";
import { AnkrTransferHistoryProvider } from "../implementations/output/transferHistory/ankrTransferHistoryProvider";
import { CachedTransferHistoryProvider } from "../implementations/output/transferHistory/cachedTransferHistoryProvider";
import { PineconeVectorStore } from "../implementations/output/vectorDB/pinecone";
import { PrivyWalletDataProvider } from "../implementations/output/walletData/privy.walletDataProvider";
import { TavilyWebSearchService } from "../implementations/output/webSearch/tavily.webSearchService";
import { AaveV3Adapter } from "../implementations/output/yield/aaveV3Adapter";
import { OnChainPositionDiscovery } from "../implementations/output/yield/onChainPositionDiscovery";
import { SubgraphPrincipalProvider } from "../implementations/output/yield/subgraphPrincipalProvider";
import { YieldProtocolRegistry } from "../implementations/output/yield/yieldProtocolRegistry";
import { ASTER_ENV } from "../../helpers/env/asterEnv";
import { AsterDiamondClient } from "../implementations/output/aster/asterDiamond.client";
import { DbStockPairRegistry } from "../implementations/output/stocks/dbStockPairRegistry";
import { AsterStockPairCrawler } from "../implementations/output/aster/asterStockPairCrawler";
import { StockPairIngestionUseCase } from "../../use-cases/implementations/stockPairIngestion.usecase";
import type { IStockPairIngestionUseCase } from "../../use-cases/interface/input/stockPairIngestion.interface";
import { StockPairCrawlerJob } from "../implementations/input/jobs/stockPairCrawlerJob";
import {
  AsterPriceOracle,
  CachedStockPriceOracle,
} from "../implementations/output/aster/asterPriceOracle";
import { AsterBrokerProvider } from "../implementations/output/aster/asterBrokerProvider";
import type { IStockPairRegistry } from "../../use-cases/interface/output/stocks/stockPair.interface";
import type { IStockPriceOracle } from "../../use-cases/interface/output/stocks/stockPriceOracle.interface";
import type { IStockBrokerProvider } from "../../use-cases/interface/output/stocks/stockBrokerProvider.interface";
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
  private _schemaCompiler: OpenAISchemaCompiler | null = null;
  private _tokenRegistryService: DbTokenRegistryService | null = null;
  private _tokenCrawlerJob: TokenCrawlerJob | null = null;
  private _stockPairCrawlerJob: StockPairCrawlerJob | null = null;
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
  // ----- Aster (tokenized stocks) -----
  private _asterDiamondClient: AsterDiamondClient | null = null;
  private _stockPairRegistry: IStockPairRegistry | null = null;
  private _stockPriceOracle: IStockPriceOracle | null = null;
  private _stockBrokerProvider: IStockBrokerProvider | null = null;
  private _stockPositionsProvider: IStockPositionsProvider | null = null;
  private _crossChainSwapPlanner: ICrossChainSwapPlanner | null = null;
  private _stockUseCase: IStockUseCase | null = null;
  /** Set true if boot-time `verifyStockCapability()` fails (fix #9 — soft fail). */
  private _stockCapabilityDisabled = false;
  private _yieldJobsNoStartWarned = {
    poolScan: false,
    idleScan: false,
    report: false,
  };

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
   * `RESULT_CARD_INTERPRETER_ENABLED` is not "true" or `OPENAI_API_KEY` is
   * unset — the renderer treats undefined as "interpreter off" and just
   * skips the optional italic note. Cache is best-effort: if Redis isn't
   * configured we run uncached.
   */
  getIntentInterpreter(): IIntentInterpreter | undefined {
    if (this._intentInterpreterChecked) {
      return this._intentInterpreter ?? undefined;
    }
    this._intentInterpreterChecked = true;
    const env = getResultCardEnv();
    if (!env.enabled || !env.apiKey) return undefined;
    const redis = this.getRedis();
    const cache = redis ? makeRedisResponseCache(redis, "interp") : undefined;
    this._intentInterpreter = new OpenAIIntentInterpreter({
      apiKey: env.apiKey,
      model: env.model,
      cache,
    });
    return this._intentInterpreter;
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

      const orchestrator = new OpenAIOrchestrator(
        process.env.OPENAI_API_KEY ?? "",
        OPENAI_MODEL,
      );

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

        // route_intent + stock_open — both re-enter the capability dispatcher
        // with a synthesized slash command. Lazy-resolve to break the
        // construction-time cycle:
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
          add(
            new StockOpenTool({
              userId,
              channelId,
              dispatcher,
              isDisabled: () => this.isStockCapabilityDisabled(),
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
      this._signingRequestUseCase = new SigningRequestUseCaseImpl(
        new RedisSigningRequestCache(redis),
        onResolved,
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
        {
          oracle: this.getStockPriceOracle(),
          pairs: this.getStockPairRegistry(),
          getStockUseCase: () => this.getStockUseCaseSync(),
          isDisabled: () => this.isStockCapabilityDisabled(),
        },
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
    registry.register(new BuyCapability(sqlDB.userProfiles, this.getChainId()));

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
      if (command === INTENT_COMMAND.WITHDRAW) continue;
      if (command === INTENT_COMMAND.POINTS) continue;
      if (command === INTENT_COMMAND.LEADERBOARD) continue;
      if (command === INTENT_COMMAND.STOCK) continue;
      if (command === INTENT_COMMAND.POSITIONS) continue;
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

    // /stock — Aster perpetuals capability. Requires the signing-request use
    // case (mini-app autosign) and a working broker provider. Soft-disabled
    // when boot verification fails (`isStockCapabilityDisabled`).
    if (this._signingRequestUseCase) {
      try {
        const stockUseCase = await this.getStockUseCase();
        registry.register(
          new StockCapability({
            stockUseCase,
            signingRequestUseCase: this._signingRequestUseCase,
            stockPairRegistry: this.getStockPairRegistry(),
            miniAppRequestCache: this.getMiniAppRequestCache(),
            loyaltyUseCase: this.getLoyaltyUseCase(),
            isStockCapabilityDisabled: () => this.isStockCapabilityDisabled(),
          }),
        );
      } catch (err) {
        log.error(
          { err },
          "/stock capability skipped — broker provider failed to initialise",
        );
      }
    } else {
      log.warn(
        { reason: "redis_unavailable" },
        "/stock capability skipped — signing-request use case not ready",
      );
    }

    // /positions — chat-seeded summariser of open Aster positions. Delegates
    // to the assistant LLM loop with a fixed prompt that nudges the agent
    // toward the `get_stock_positions` tool.
    registry.register(
      new PositionsCapability(
        () => this.getStockUseCaseSync(),
        () => this.isStockCapabilityDisabled(),
      ),
    );

    // Free-text fallback: the LLM loop. Handles anything that isn't a slash
    // command and isn't continuing a pending capability flow.
    registry.registerDefault(new AssistantChatCapability(this.getUseCase()));

    this._capabilityDispatcher = new CapabilityDispatcher(
      registry,
      renderer,
      pending,
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
      this.getStockPairRegistry(),
      this.getStockPriceOracle(),
      () => this.isStockCapabilityDisabled(),
      () => this.getStockUseCaseSync(),
      this.getSubgraphPrincipalProvider(),
      this.getPendingIntentStore(),
      () => this.getCapabilityDispatcher(),
    );
  }

  // -------------------------------------------------------------------
  // Aster (tokenized stocks) — Phase 1 wiring.
  // -------------------------------------------------------------------

  getAsterDiamondClient(): AsterDiamondClient {
    if (!this._asterDiamondClient) {
      this._asterDiamondClient = new AsterDiamondClient();
    }
    return this._asterDiamondClient;
  }

  getStockPairRegistry(): IStockPairRegistry {
    if (!this._stockPairRegistry) {
      // DB-backed; the in-memory snapshot is empty until `refresh()` runs.
      // `verifyStockCapability` calls `refresh()` once at boot, and the
      // crawler job (`getStockPairCrawlerJob`) refreshes after every tick.
      this._stockPairRegistry = new DbStockPairRegistry(
        this.getSqlDB().stockPairs,
        this.getAsterBrokerVenueChainId(),
      );
    }
    return this._stockPairRegistry;
  }

  /** Aster's venue chain id (BSC = 56). Sourced from the broker provider's
   * `venueChainId` getter once it's been constructed; before that, falls back
   * to the well-known constant 56. The fallback is intentional — at boot the
   * registry is built before the broker (the broker depends on the registry)
   * so we cannot transitively read `broker.venueChainId` here. */
  getAsterBrokerVenueChainId(): number {
    return this._stockBrokerProvider?.venueChainId ?? 56;
  }

  getStockPairCrawlerJob(): StockPairCrawlerJob {
    if (!this._stockPairCrawlerJob) {
      const intervalMs = parseInt(
        process.env.STOCK_PAIR_CRAWLER_INTERVAL_MS ?? String(60 * 60 * 1000),
        10,
      );
      const ingestion = new StockPairIngestionUseCase(
        new AsterStockPairCrawler(this.getAsterDiamondClient()),
        this.getSqlDB().stockPairs,
      );
      // Wrap so the registry's in-memory snapshot follows DB state without
      // a second timer.
      const wrapped: IStockPairIngestionUseCase = {
        ingest: async (chainId: number) => {
          await ingestion.ingest(chainId);
          await this.getStockPairRegistry().refresh();
        },
      };
      this._stockPairCrawlerJob = new StockPairCrawlerJob(
        wrapped,
        this.getAsterBrokerVenueChainId(),
        intervalMs,
      );
    }
    return this._stockPairCrawlerJob;
  }

  getStockPriceOracle(): IStockPriceOracle {
    if (!this._stockPriceOracle) {
      const inner = new AsterPriceOracle(
        this.getAsterDiamondClient(),
        this.getStockPairRegistry(),
      );
      this._stockPriceOracle = new CachedStockPriceOracle(inner, {
        ttlSec: ASTER_ENV.priceTtlSec,
      });
    }
    return this._stockPriceOracle;
  }

  /**
   * Per-user-bound positions provider. Each call returns a fresh cached
   * wrapper keyed by `userId` so users don't see one another's positions.
   * The underlying `AsterPositionsProvider` is shared.
   */
  getStockPositionsProvider(_userId: string): IStockPositionsProvider {
    // Per-process cache is fine; cache key includes the trader address so
    // users with different SCAs never collide.
    if (!this._stockPositionsProvider) {
      // Decimals must come from the broker's collateral token, never
      // hardcoded. `verifyStockCapability` eagerly constructs the broker
      // at boot so this lookup is always satisfied by the time the
      // capability dispatcher reaches positions.
      if (!this._stockBrokerProvider) {
        throw new Error(
          "stock broker provider not initialised — call verifyStockCapability() first",
        );
      }
      const inner = new AsterPositionsProvider(
        this.getAsterDiamondClient(),
        this.getStockPairRegistry(),
        this._stockBrokerProvider.collateralToken.decimals,
      );
      this._stockPositionsProvider = new CachedStockPositionsProvider(inner, {
        ttlSec: ASTER_ENV.positionsTtlSec,
      });
    }
    return this._stockPositionsProvider;
  }

  getCrossChainSwapPlanner(): ICrossChainSwapPlanner {
    if (!this._crossChainSwapPlanner) {
      this._crossChainSwapPlanner = new RelayCrossChainSwapPlanner(
        this.getRelayClient(),
      );
    }
    return this._crossChainSwapPlanner;
  }

  /**
   * Memoised stock use-case. Async because the broker construction reads
   * `tokenRegistry`. Used by both the `/stock` capability dispatcher and
   * the read-only HTTP routes (`/stocks/positions`).
   */
  async getStockUseCase(): Promise<IStockUseCase> {
    if (!this._stockUseCase) {
      const broker = await this.getStockBrokerProvider();
      this._stockUseCase = new StockUseCaseImpl({
        broker,
        positions: (uid) => this.getStockPositionsProvider(uid),
        oracle: this.getStockPriceOracle(),
        pairs: this.getStockPairRegistry(),
        crossChainSwap: this.getCrossChainSwapPlanner(),
        userProfileRepo: this.getSqlDB().userProfiles,
        tokenRegistry: this.getTokenRegistryService(),
      });
    }
    return this._stockUseCase;
  }

  /** Sync accessor for the memoised stock use-case. Returns null if it has
   * not yet been constructed (verifyStockCapability is the boot path that
   * eagerly initialises it). */
  getStockUseCaseSync(): IStockUseCase | null {
    return this._stockUseCase;
  }

  /** Memoised broker provider (async because USDC.bsc decimals come from token_registry). */
  async getStockBrokerProvider(): Promise<IStockBrokerProvider> {
    if (!this._stockBrokerProvider) {
      this._stockBrokerProvider = await AsterBrokerProvider.create(
        this.getAsterDiamondClient(),
        this.getStockPairRegistry(),
        this.getTokenRegistryService(),
      );
    }
    return this._stockBrokerProvider;
  }

  isStockCapabilityDisabled(): boolean {
    return this._stockCapabilityDisabled;
  }

  /**
   * Boot-time verification (fix #9 — soft fail). On failure, the soft-disable
   * flag flips on; HTTP routes return 503 and (in Phase 2) the stock
   * capability replies with a friendly "stocks unavailable" message.
   * Non-stock features keep booting either way.
   */
  async verifyStockCapability(): Promise<void> {
    try {
      // 1. Eagerly construct the broker + use-case so collateral decimals
      //    are available synchronously to `getStockPositionsProvider`
      //    (sync factory) and the HTTP routes can hand off to a ready
      //    use-case via `getStockUseCaseSync()`.
      await this.getStockUseCase();

      // 2. Always run a fresh ingest at boot. Upserts are idempotent and
      //    cheap (~1–2s for one chain read + a few dozen rows). Doing it
      //    unconditionally — instead of "only when empty" — means stale
      //    rows from a prior partial run can't shadow the live pair list,
      //    and a chain-side delisting is caught on restart instead of
      //    waiting for the next cron tick. Subsequent refreshes follow the
      //    crawler tick.
      const registry = this.getStockPairRegistry();
      log.info({ step: "bootstrap-ingest" }, "running stock_pairs ingest");
      const ingestion = new StockPairIngestionUseCase(
        new AsterStockPairCrawler(this.getAsterDiamondClient()),
        this.getSqlDB().stockPairs,
      );
      await ingestion.ingest(this.getAsterBrokerVenueChainId());
      await registry.refresh();

      if (registry.symbols().length === 0) {
        throw new Error(
          "stock_pairs still empty after bootstrap ingest — check that the " +
            "0029_stock_pairs migration ran and that the BSC RPC + SEC EDGAR " +
            "are reachable",
        );
      }

      log.info(
        { step: "succeeded", count: registry.symbols().length },
        "stock capability verified",
      );
    } catch (err) {
      this._stockCapabilityDisabled = true;
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        { err: msg },
        "stock capability disabled — boot verification failed",
      );
    }
  }
}
