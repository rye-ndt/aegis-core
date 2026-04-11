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
import { SmartAccountAdapter } from "../implementations/output/blockchain/smartAccount.adapter";
import { SessionKeyAdapter } from "../implementations/output/blockchain/sessionKey.adapter";
import { UserOperationBuilder } from "../implementations/output/blockchain/userOperation.builder";
import { SolverRegistry } from "../implementations/output/solver/solverRegistry";
import { ClaimRewardsSolver } from "../implementations/output/solver/static/claimRewards.solver";
import { TraderJoeSolver } from "../implementations/output/solver/restful/traderJoe.solver";
import { RpcSimulator } from "../implementations/output/simulator/rpc.simulator";
import { OpenAIIntentParser } from "../implementations/output/intentParser/openai.intentParser";
import { OpenAIIntentClassifier } from "../implementations/output/intentParser/openai.intentClassifier";
import { OpenAISchemaCompiler } from "../implementations/output/intentParser/openai.schemaCompiler";
import { ToolRegistrationUseCase } from "../../use-cases/implementations/toolRegistration.usecase";
import type { IToolRegistrationUseCase } from "../../use-cases/interface/input/toolRegistration.interface";
import { DbTokenRegistryService } from "../implementations/output/tokenRegistry/db.tokenRegistry";
import { TxResultParser } from "../implementations/output/resultParser/tx.resultParser";
import { PangolinTokenCrawler } from "../implementations/output/tokenCrawler/pangolin.tokenCrawler";
import { TokenCrawlerJob } from "../implementations/input/jobs/tokenCrawlerJob";
import { TokenIngestionUseCase } from "../../use-cases/implementations/tokenIngestion.usecase";
import { INTENT_ACTION } from "../../use-cases/interface/output/intentParser.interface";
import { OpenAIEmbeddingService } from "../implementations/output/embedding/openai";
import { PineconeVectorStore } from "../implementations/output/vectorDB/pinecone";
import { PineconeToolIndexService } from "../implementations/output/toolIndex/pinecone.toolIndex";
import type { IToolIndexService } from "../../use-cases/interface/output/toolIndex.interface";
import { PrivyServerAuthAdapter } from "../implementations/output/privyAuth/privyServer.adapter";
import { RedisSessionDelegationCache } from '../implementations/output/cache/redis.sessionDelegation';
import type { ISessionDelegationCache } from '../../use-cases/interface/output/cache/sessionDelegation.cache';
import { PortfolioUseCaseImpl } from '../../use-cases/implementations/portfolio.usecase';
import type { IPortfolioUseCase } from '../../use-cases/interface/input/portfolio.interface';
import { SessionDelegationUseCaseImpl } from '../../use-cases/implementations/sessionDelegation.usecase';
import type { ISessionDelegationUseCase } from '../../use-cases/interface/input/sessionDelegation.interface';
import { DelegationRequestBuilder } from '../implementations/output/delegation/delegationRequestBuilder';
import type { IDelegationRequestBuilder } from '../../use-cases/interface/output/delegation/delegationRequestBuilder.interface';

export class AssistantInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private useCase: IAssistantUseCase | null = null;
  private _authUseCase: IAuthUseCase | null = null;
  private _intentUseCase: IIntentUseCase | null = null;
  private _viemClient: ViemClientAdapter | null = null;
  private _smartAccountService: SmartAccountAdapter | null = null;
  private _sessionKeyService: SessionKeyAdapter | null = null;
  private _userOpBuilder: UserOperationBuilder | null = null;
  private _solverRegistry: SolverRegistry | null = null;
  private _intentParser: OpenAIIntentParser | null = null;
  private _intentClassifier: OpenAIIntentClassifier | null = null;
  private _schemaCompiler: OpenAISchemaCompiler | null = null;
  private _toolRegistrationUseCase: IToolRegistrationUseCase | null = null;
  private _tokenRegistryService: DbTokenRegistryService | null = null;
  private _tokenCrawlerJob: TokenCrawlerJob | null = null;
  private _simulator: RpcSimulator | null = null;
  private _resultParser: TxResultParser | null = null;
  private _embeddingService: OpenAIEmbeddingService | null = null;
  private _toolVectorStore: PineconeVectorStore | null = null;
  private _toolIndexService: IToolIndexService | null = null;
  private _privyAuthService: PrivyServerAuthAdapter | null = null;
  private _sessionDelegationCache: ISessionDelegationCache | null = null;
  private _portfolioUseCase: IPortfolioUseCase | null = null;
  private _sessionDelegationUseCase: ISessionDelegationUseCase | null = null;
  private _delegationRequestBuilder: DelegationRequestBuilder | null = null;

  private getChainId(): number {
    return parseInt(process.env.CHAIN_ID ?? "43113", 10);
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
        rpcUrl: process.env.AVAX_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
        botPrivateKey: process.env.BOT_PRIVATE_KEY ?? "",
        chainId: this.getChainId(),
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
      this._solverRegistry.register(
        INTENT_ACTION.SWAP,
        new TraderJoeSolver(
          process.env.TRADERJOE_API_URL ?? "https://api.traderjoexyz.com",
          chainId,
        ),
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

  getSimulator(): RpcSimulator {
    if (!this._simulator) {
      this._simulator = new RpcSimulator(this.getViemClient());
    }
    return this._simulator;
  }

  getResultParser(): TxResultParser {
    if (!this._resultParser) {
      this._resultParser = new TxResultParser(this.getViemClient());
    }
    return this._resultParser;
  }

  getUserOpBuilder(): UserOperationBuilder {
    if (!this._userOpBuilder) {
      this._userOpBuilder = new UserOperationBuilder(
        this.getViemClient(),
        process.env.ENTRY_POINT_ADDRESS ?? "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
        process.env.AVAX_BUNDLER_URL ?? "",
        process.env.BOT_PRIVATE_KEY ?? "",
        process.env.TREASURY_ADDRESS ?? "",
      );
    }
    return this._userOpBuilder;
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
        this.getUserOpBuilder(),
        this.getSimulator(),
        db.intents,
        db.intentExecutions,
        db.feeRecords,
        db.userProfiles,
        db.messages,
        this.getResultParser(),
        chainId,
        process.env.TREASURY_ADDRESS ?? "",
        db.toolManifests,
        this.getToolIndexService(),
        this.getIntentClassifier(),
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

      const registryFactory = (userId: string, conversationId: string): IToolRegistry => {
        const r = new ToolRegistryConcrete();
        r.register(new WebSearchTool(webSearchService));
        r.register(new ExecuteIntentTool(userId, conversationId, intentUseCase));
        r.register(new GetPortfolioTool(userId, userProfileDB, tokenRegistryService, viemClient, chainId));
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
      const db = this.getSqlDB();
      const chainId = this.getChainId();
      const botAddress = process.env.BOT_ADDRESS ?? "";

      let smartAccountService: SmartAccountAdapter | undefined;
      let sessionKeyService: SessionKeyAdapter | undefined;

      if (process.env.BOT_PRIVATE_KEY && process.env.JARVIS_ACCOUNT_FACTORY_ADDRESS) {
        if (!this._smartAccountService) {
          this._smartAccountService = new SmartAccountAdapter(
            this.getViemClient(),
            process.env.JARVIS_ACCOUNT_FACTORY_ADDRESS,
            botAddress,
          );
        }
        smartAccountService = this._smartAccountService;
      }

      if (process.env.BOT_PRIVATE_KEY && process.env.SESSION_KEY_MANAGER_ADDRESS) {
        if (!this._sessionKeyService) {
          this._sessionKeyService = new SessionKeyAdapter(
            this.getViemClient(),
            process.env.SESSION_KEY_MANAGER_ADDRESS,
            botAddress,
          );
        }
        sessionKeyService = this._sessionKeyService;
      }

      this._authUseCase = new AuthUseCaseImpl(
        db.users,
        process.env.JWT_SECRET ?? "",
        process.env.JWT_EXPIRES_IN ?? "7d",
        db.userProfiles,
        smartAccountService,
        sessionKeyService,
        // Default allowed token addresses for Fuji
        ["0x5425890298aed601595a70AB815c96711a31Bc65", "0xd00ae08403B9bbb9124bB305C09058E32C39A48c"],
        this.getPrivyAuthService(),
      );
    }
    return this._authUseCase;
  }

  getSessionDelegationCache(): ISessionDelegationCache | undefined {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return undefined;
    if (!this._sessionDelegationCache) {
      this._sessionDelegationCache = new RedisSessionDelegationCache(redisUrl);
    }
    return this._sessionDelegationCache;
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

  getHttpApiServer(): HttpApiServer {
    const port = parseInt(process.env.HTTP_API_PORT ?? "4000", 10);
    return new HttpApiServer(
      this.getAuthUseCase(),
      null,
      port,
      process.env.JWT_SECRET,
      this.getIntentUseCase(),
      this.getPortfolioUseCase(),
      this.getToolRegistrationUseCase(),
      this.getSessionDelegationUseCase(),
      this.getSqlDB().pendingDelegations,
    );
  }
}
