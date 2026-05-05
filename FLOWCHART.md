# Backend Flow Map

Each fenced ` ```mermaid ` block is independently pasteable into https://mermaid.live.

Legend (in flowchart):
- 🟢 entry point / process
- 🟦 adapter (input or output)
- 🟧 use-case / capability
- 🟥 suspected dead / superseded code
- dashed edge = job / scheduled trigger

---

## 1. High-level architecture flowchart

Shows every entry point → adapter → use-case/capability → outbound adapter, with dead ends marked.

```mermaid
%%{init: {'flowchart': {'curve': 'linear'}, 'themeVariables': {'fontSize': '13px'}}}%%
flowchart LR
    %% ---------- ENTRY ----------
    subgraph ENTRY["🟢 Entry points"]
        EP[entrypoint.ts<br/>PROCESS_ROLE switch]
        HTTPC[httpCli.ts<br/>HTTP only]
        TGC[telegramCli.ts<br/>combined: TG + HTTP + jobs]
        WC[workerCli.ts<br/>worker + extra jobs]
        MIG[migrate.ts<br/>drizzle migrations]
    end
    EP --> HTTPC
    EP --> TGC
    EP --> WC
    EP --> MIG

    %% ---------- INPUT ADAPTERS ----------
    subgraph INPUT["🟦 Input adapters"]
        HTTP[HttpApiServer<br/>REST routes]
        TGH[TelegramHandler<br/>messages + callbacks]
        subgraph JOBS["Jobs (cron)"]
            J1[TokenCrawlerJob ~15m]
            J2[StockPairCrawlerJob ~1h]
            J3[YieldPoolScanJob]
            J4[UserIdleScanJob ~6h]
            J5[YieldReportJob daily]
        end
    end
    HTTPC --> HTTP
    TGC --> HTTP
    TGC --> TGH
    TGC -.-> J1 & J3 & J4 & J5
    WC --> HTTP
    WC --> TGH
    WC -.-> J1 & J2 & J3 & J4 & J5

    %% ---------- DISPATCH ----------
    DISP[CapabilityDispatcher<br/>collect → run]
    TGH --> DISP

    %% ---------- CAPABILITIES ----------
    subgraph CAP["🟧 Capabilities"]
        CBuy[BuyCapability /buy]
        CSend[SendCapability<br/>/send /transfer /delegate /grant /refund /repay /collect]
        CSwap[SwapCapability /swap]
        CYield[YieldCapability /yield]
        CLoy[LoyaltyCapability /points /leaderboard]
        CStock[StockCapability /stock]
        CPos[PositionsCapability /positions]
        CChat[AssistantChatCapability default]
    end
    DISP --> CBuy & CSend & CSwap & CYield & CLoy & CStock & CPos & CChat

    %% ---------- USE CASES ----------
    subgraph UC["🟧 Use-cases"]
        UAuth[AuthUseCase]
        UAsst[AssistantUseCase<br/>LLM tool loop]
        UIntent[IntentUseCase<br/>schema compile + token search]
        USign[SigningRequestUseCase]
        UPort[PortfolioUseCase]
        UTrans[TransferHistoryUseCase]
        UStock[StockUseCase]
        UYield[YieldOptimizerUseCase]
        ULoy[LoyaltyUseCase]
        UNotif[RecipientNotificationUseCase]
        UStockIng[StockPairIngestionUseCase]
        UTokIng[TokenIngestionUseCase]
        USess[(SessionDelegationUseCase)]:::dead
    end

    %% HTTP routes -> use-cases
    HTTP --> UAuth
    HTTP --> USign
    HTTP --> UPort
    HTTP --> UTrans
    HTTP --> UYield
    HTTP --> ULoy
    HTTP --> UStock

    %% Capabilities -> use-cases
    CSend --> UIntent
    CSwap --> UIntent
    CSend --> USign
    CSwap --> USign
    CYield --> USign
    CYield --> UYield
    CStock --> USign
    CStock --> UStock
    CLoy --> ULoy
    CPos --> CChat
    CChat --> UAsst
    UAsst -. "tool: getPortfolio" .-> UPort
    UAsst -. "tool: getTransferHistory" .-> UTrans
    UAsst -. "tool: getStockQuote/Positions" .-> UStock
    UAsst -. "tool: routeIntent" .-> DISP

    %% Jobs -> use-cases
    J1 -.-> UTokIng
    J2 -.-> UStockIng
    J3 -.-> UYield
    J4 -.-> UYield
    J4 -.-> UNotif
    J5 -.-> UYield
    J5 -.-> UNotif

    %% ---------- OUTPUT ADAPTERS ----------
    subgraph OUT["🟦 Output adapters"]
        DB[(Postgres / Drizzle<br/>14 repos)]
        REDIS[(Redis caches)]
        VIEM[Viem RPC]
        ANKR[Ankr API]
        SUB[Aave Subgraph]
        AAVE[AaveV3 onchain]
        ASTER[Aster Diamond]
        RELAY[Relay SDK]
        PRIVY[Privy auth]
        TG[Telegram API<br/>+ gramjs MTProto]
        OAI[OpenAI<br/>orchestrator+schema+intent]
        TAV[Tavily web search]
        PINE[Pinecone vector DB]:::dead
        REND[TelegramArtifactRenderer]
    end

    UAuth --> PRIVY & DB & REDIS & TG
    UAsst --> OAI & DB
    UIntent --> OAI & DB
    USign --> REDIS & DB & TG
    UPort --> ANKR & VIEM & DB & REDIS
    UTrans --> ANKR & REDIS
    UYield --> AAVE & SUB & VIEM & DB
    UStock --> ASTER & VIEM & RELAY & DB
    ULoy --> DB
    UNotif --> TG
    UTokIng --> DB
    UStockIng --> ASTER & DB
    UAsst -. "webSearch tool" .-> TAV

    %% Capability rendering
    CBuy & CSend & CSwap & CYield & CLoy & CStock & CPos & CChat --> REND
    REND --> TG
    REND --> REDIS

    %% ---------- DEAD ENDS ----------
    subgraph DEAD["🟥 Suspected dead / superseded"]
        D1[sessionDelegation.usecase.ts<br/>DI-only, no callers]:::dead
        D2[aegisGuardInterceptor.ts<br/>replaced by tokenDelegation]:::dead
        D3[SolverRegistry empty]:::dead
        D4[Pinecone tool RAG<br/>gated by env, optional]:::dead
        D5[message:web_app_data<br/>legacy, replaced by /auth/privy]:::dead
    end
    USess -.-> D1
    TGH -.-> D5

    classDef dead fill:#ffe0e0,stroke:#c0392b,color:#7b241c,stroke-dasharray:4 3;
```

---

## 2. Sequence: Telegram `/send 10 USDC to @alice`

```mermaid
sequenceDiagram
    autonumber
    actor U as User (Telegram)
    participant TG as Telegram API
    participant H as TelegramHandler
    participant D as CapabilityDispatcher
    participant SC as SendCapability
    participant IU as IntentUseCase
    participant TR as TokenRegistry
    participant RE as ResolverEngine
    participant TD as TokenDelegationDB
    participant R as Renderer
    participant RD as Redis
    participant MA as Mini-app
    participant HS as HttpApiServer
    participant SR as SigningRequestUseCase

    U->>TG: "/send 10 USDC to @alice"
    TG->>H: message:text
    H->>D: handle(input)
    D->>SC: collect(stage=compile)
    SC->>IU: compileSchema()
    IU->>TR: searchTokens("USDC")
    IU-->>SC: {token, amount, recipient}
    D->>SC: run(params)
    SC->>RE: resolve(@alice → EOA)
    SC->>TD: getBalance(spend allowance)
    SC-->>D: artifact: sign_calldata
    D->>R: render(artifact)
    R->>RD: store SigningRequest + MiniAppRequest
    R->>TG: "Review in mini-app"

    MA->>HS: POST /response (txHash)
    HS->>SR: resolveRequest()
    SR->>TD: addSpent()
    SR->>TG: notify resolved
    TG-->>U: confirmation
```

---

## 3. Sequence: HTTP `POST /auth/privy`

```mermaid
sequenceDiagram
    autonumber
    participant MA as Mini-app
    participant HS as HttpApiServer
    participant AU as AuthUseCase
    participant P as PrivyServerAuth
    participant DB as UserDB / SessionDB / ProfileDB
    participant RD as UserProfileCache
    participant TG as TelegramNotifier

    MA->>HS: POST /auth/privy {privyToken, telegramChatId}
    HS->>AU: loginWithPrivy(token)
    AU->>P: verifyToken()
    P-->>AU: {privyDid, email}
    AU->>DB: findByPrivyDid / findByEmail / create
    AU->>DB: upsert telegram session
    AU->>DB: setTelegramChatId
    AU->>RD: cache profile
    AU->>TG: send welcome
    AU-->>HS: {userId, expiresAtEpoch}
    HS-->>MA: 200 OK
```

---

## 4. Sequence: HTTP `GET /yield/positions`

```mermaid
sequenceDiagram
    autonumber
    participant MA as Mini-app
    participant HS as HttpApiServer
    participant AU as AuthUseCase
    participant PU as PortfolioUseCase
    participant YU as YieldOptimizerUseCase
    participant YR as YieldProtocolRegistry
    participant AV as AaveV3Adapter
    participant SP as SubgraphPrincipalProvider
    participant OD as OnChainPositionDiscovery

    MA->>HS: GET /yield/positions (Privy)
    HS->>AU: resolveUserId(privyToken)
    AU-->>HS: userId
    HS->>PU: getYieldPositions(userId, chainId)
    PU->>YU: getUserPositions
    YU->>YR: getAavePositions
    par
        YR->>AV: getUserAccountData(SCA)
    and
        YR->>SP: getPrincipal
    and
        YR->>OD: getATokenBalance
    end
    YR-->>YU: positions
    YU-->>PU: {deposits, borrows, apy}
    PU-->>HS: payload
    HS-->>MA: 200 JSON
```

---

## 5. Sequence: Worker — UserIdleScanJob → Telegram nudge

```mermaid
sequenceDiagram
    autonumber
    participant CRON as Scheduler (~6h)
    participant J as UserIdleScanJob
    participant YU as YieldOptimizerUseCase
    participant DB as YieldRepo / UserDB
    participant N as RecipientNotificationUseCase
    participant TG as TelegramNotifier

    CRON->>J: tick
    J->>YU: findIdlePositions(chainId)
    YU->>DB: query inactive positions
    DB-->>YU: idle list
    YU-->>J: positions
    J->>N: sendNudges(positions)
    loop per user
        N->>TG: sendMessage(chatId, "You have idle USDC…")
    end
```

---

## 6. Where to look for dead code

| Suspect | Path hint | Why |
|---|---|---|
| `SessionDelegationUseCase` | `src/use-cases/sessionDelegation.usecase.ts` | DI-instantiated only; no production callers — superseded by token delegation flow |
| `aegisGuardInterceptor` | adapter helper | replaced by `tokenDelegations` repo + `SigningRequestUseCase.addSpent` |
| `SolverRegistry` | adapter | empty registry, never resolved |
| Pinecone tool RAG (`PineconeToolIndexService`, `OpenAIEmbeddingService`, `PineconeVectorStore`) | output adapters | gated by API keys; if env unset, never invoked at runtime |
| Telegram `message:web_app_data` legacy auth | `telegram/handler.ts` | replaced by `POST /auth/privy` |
| `/swagger` route | http server | no `swagger.json` served |

Cross-check before deleting: `grep -R "<symbol>" src/` and confirm only DI wiring references it.
