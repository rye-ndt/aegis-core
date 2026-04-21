# HTTP Query Tool — Backend Implementation Plan

> Date: 2026-04-21
> Status: Draft
> Touches: `schema.ts`, `assistant.usecase.ts`, `assistant.di.ts`, `httpServer.ts`, `tool.interface.ts`, new files

---

## Goal

Add a new user-configurable tool type called **http query** that lets any authenticated user register an external HTTP endpoint as a tool. When the LLM decides to invoke that tool, the system:

1. Queries Redis for the current user's profile (wallet address, email, etc.)
2. Calls an internal LLM to marshal the tool input + user context → full request body
3. Sends the HTTP request (GET/POST/PUT) with decrypted headers
4. Calls another internal LLM pass to interpret the JSON response into plain language
5. Returns the interpreted result to the main agent loop

Header values may be marked `encrypt: true` at registration time; those values are AES-256-GCM encrypted before being stored and decrypted at request time using a key from `.env`.

---

## Architecture Diagram

```
POST /http-tools  (registration)
  │── Validate & encrypt marked headers
  │── Store in http_query_tools + http_query_tool_headers
  └── Return { id, name }

AssistantUseCaseImpl.chat()
  │── registryFactory(userId, conversationId)  ← now async
  │     ├── WebSearchTool
  │     ├── ExecuteIntentTool
  │     ├── GetPortfolioTool
  │     └── HttpQueryTool[]   ← loaded from DB per userId
  └── LLM loop …
        └── HttpQueryTool.execute(input)
              ├── userProfileCache.get(userId)   ← Redis
              ├── userProfileDB.findByUserId()   ← DB (wallet addresses)
              ├── LLM marshal: (requestBodySchema + toolInput + userContext) → body
              ├── headers: decrypt encrypted values
              ├── fetch(endpoint, { method, headers, body })
              ├── LLM interpret: raw JSON → natural language
              └── return IToolOutput { success, data }
```

---

## File Map

| File | Change |
|---|---|
| `src/helpers/crypto/aes.ts` | **NEW** AES-256-GCM encrypt/decrypt helpers |
| `src/adapters/implementations/output/sqlDB/schema.ts` | **Modified** add `httpQueryTools`, `httpQueryToolHeaders` tables |
| `src/adapters/implementations/output/sqlDB/migrations/YYYYMMDD_http_query_tools.ts` | **NEW** Drizzle migration |
| `src/use-cases/interface/output/repository/httpQueryTool.repo.ts` | **NEW** port `IHttpQueryToolDB` |
| `src/use-cases/interface/input/httpQueryTool.interface.ts` | **NEW** port `IHttpQueryToolUseCase` |
| `src/use-cases/implementations/httpQueryTool.usecase.ts` | **NEW** use-case implementation |
| `src/adapters/implementations/output/sqlDB/repositories/httpQueryTool.repo.ts` | **NEW** Drizzle repository |
| `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts` | **Modified** expose new repo |
| `src/adapters/implementations/output/tools/httpQuery.tool.ts` | **NEW** `HttpQueryTool` implementing `ITool` |
| `src/use-cases/interface/output/tool.interface.ts` | **Modified** relax `name` type from `TOOL_TYPE` to `string` |
| `src/adapters/implementations/output/toolRegistry.concrete.ts` | **Modified** Map key becomes `string` |
| `src/use-cases/implementations/assistant.usecase.ts` | **Modified** `registryFactory` async, `await` the call |
| `src/adapters/inject/assistant.di.ts` | **Modified** async `registryFactory`, wire `HttpQueryTool` |
| `src/adapters/implementations/input/http/httpServer.ts` | **Modified** add 3 new routes |

---

## Step 1 — Encryption helper

**File:** `src/helpers/crypto/aes.ts`

Uses Node's built-in `crypto` module. Key is a 32-byte hex string from `process.env.HTTP_TOOL_HEADER_ENCRYPTION_KEY`.

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export function encryptValue(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptValue(ciphertext: string, keyHex: string): string {
  const [ivHex, authTagHex, encHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !encHex) throw new Error("INVALID_ENCRYPTED_FORMAT");
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}
```

**Note:** If `HTTP_TOOL_HEADER_ENCRYPTION_KEY` is not set, any attempt to register a header with `encrypt: true` should throw `ENCRYPTION_KEY_NOT_CONFIGURED` before storing anything.

---

## Step 2 — DB Schema additions

**File:** `src/adapters/implementations/output/sqlDB/schema.ts`

Append after the existing table definitions:

```typescript
export const httpQueryTools = pgTable("http_query_tools", {
  id:                uuid("id").primaryKey(),
  userId:            uuid("user_id").notNull(),
  name:              text("name").notNull(),
  description:       text("description").notNull(),
  endpoint:          text("endpoint").notNull(),
  method:            text("method").notNull(),           // 'GET' | 'POST' | 'PUT'
  requestBodySchema: text("request_body_schema").notNull(), // JSON Schema stored as text
  isActive:          boolean("is_active").notNull().default(true),
  createdAtEpoch:    integer("created_at_epoch").notNull(),
  updatedAtEpoch:    integer("updated_at_epoch").notNull(),
}, (t) => ({
  userNameUniq: unique().on(t.userId, t.name),
}));

export const httpQueryToolHeaders = pgTable("http_query_tool_headers", {
  id:             uuid("id").primaryKey(),
  toolId:         uuid("tool_id").notNull(),    // FK to http_query_tools.id (soft)
  headerKey:      text("header_key").notNull(),
  headerValue:    text("header_value").notNull(), // plaintext or encrypted blob
  isEncrypted:    boolean("is_encrypted").notNull().default(false),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
```

---

## Step 3 — Drizzle migration

**File:** `src/adapters/implementations/output/sqlDB/migrations/<timestamp>_http_query_tools.sql`

(Generate via `drizzle-kit generate` after updating `schema.ts`, or write the SQL manually following the same pattern as existing migrations.)

```sql
CREATE TABLE "http_query_tools" (
  "id"                  uuid PRIMARY KEY,
  "user_id"             uuid NOT NULL,
  "name"                text NOT NULL,
  "description"         text NOT NULL,
  "endpoint"            text NOT NULL,
  "method"              text NOT NULL,
  "request_body_schema" text NOT NULL,
  "is_active"           boolean NOT NULL DEFAULT true,
  "created_at_epoch"    integer NOT NULL,
  "updated_at_epoch"    integer NOT NULL,
  UNIQUE ("user_id", "name")
);

CREATE TABLE "http_query_tool_headers" (
  "id"              uuid PRIMARY KEY,
  "tool_id"         uuid NOT NULL,
  "header_key"      text NOT NULL,
  "header_value"    text NOT NULL,
  "is_encrypted"    boolean NOT NULL DEFAULT false,
  "created_at_epoch" integer NOT NULL
);
```

---

## Step 4 — Port: `IHttpQueryToolDB`

**File:** `src/use-cases/interface/output/repository/httpQueryTool.repo.ts`

```typescript
export interface IHttpQueryTool {
  id: string;
  userId: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT";
  requestBodySchema: string; // raw JSON text
  isActive: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IHttpQueryToolHeader {
  id: string;
  toolId: string;
  headerKey: string;
  headerValue: string;
  isEncrypted: boolean;
}

export interface ICreateHttpQueryTool {
  id: string;
  userId: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT";
  requestBodySchema: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface ICreateHttpQueryToolHeader {
  id: string;
  toolId: string;
  headerKey: string;
  headerValue: string;
  isEncrypted: boolean;
  createdAtEpoch: number;
}

export interface IHttpQueryToolDB {
  create(tool: ICreateHttpQueryTool): Promise<void>;
  createHeaders(headers: ICreateHttpQueryToolHeader[]): Promise<void>;
  findActiveByUser(userId: string): Promise<IHttpQueryTool[]>;
  findById(id: string): Promise<IHttpQueryTool | null>;
  getHeaders(toolId: string): Promise<IHttpQueryToolHeader[]>;
  deactivate(id: string, userId: string): Promise<void>;
}
```

---

## Step 5 — Port: `IHttpQueryToolUseCase`

**File:** `src/use-cases/interface/input/httpQueryTool.interface.ts`

```typescript
export interface IRegisterHttpQueryToolInput {
  userId: string;
  name: string;          // validated: /^[a-z][a-z0-9_]{0,62}$/ (snake_case, max 63 chars)
  description: string;
  endpoint: string;      // must be a valid URL
  method: "GET" | "POST" | "PUT";
  requestBodySchema: Record<string, unknown>; // JSON Schema object
  headers: Array<{
    key: string;
    value: string;
    encrypt: boolean;
  }>;
}

export interface IListHttpQueryToolsOutput {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: string;
  requestBodySchema: Record<string, unknown>;
  headers: Array<{ key: string; isEncrypted: boolean }>;
  createdAtEpoch: number;
}

export interface IHttpQueryToolUseCase {
  register(input: IRegisterHttpQueryToolInput): Promise<{ id: string; name: string }>;
  list(userId: string): Promise<IListHttpQueryToolsOutput[]>;
  deactivate(id: string, userId: string): Promise<void>;
}
```

---

## Step 6 — Use-case implementation

**File:** `src/use-cases/implementations/httpQueryTool.usecase.ts`

```typescript
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { encryptValue } from "../../helpers/crypto/aes";
import type { IHttpQueryToolDB } from "../interface/output/repository/httpQueryTool.repo";
import type {
  IHttpQueryToolUseCase,
  IRegisterHttpQueryToolInput,
  IListHttpQueryToolsOutput,
} from "../interface/input/httpQueryTool.interface";

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export class HttpQueryToolUseCaseImpl implements IHttpQueryToolUseCase {
  constructor(
    private readonly db: IHttpQueryToolDB,
    private readonly encryptionKey?: string,
  ) {}

  async register(input: IRegisterHttpQueryToolInput): Promise<{ id: string; name: string }> {
    if (!TOOL_NAME_RE.test(input.name)) {
      throw new Error("INVALID_TOOL_NAME: must be snake_case, start with letter, max 63 chars");
    }
    try { new URL(input.endpoint); } catch { throw new Error("INVALID_ENDPOINT_URL"); }

    const hasEncryptedHeaders = input.headers.some((h) => h.encrypt);
    if (hasEncryptedHeaders && !this.encryptionKey) {
      throw new Error("ENCRYPTION_KEY_NOT_CONFIGURED");
    }

    const id = newUuid();
    const now = newCurrentUTCEpoch();

    await this.db.create({
      id,
      userId: input.userId,
      name: input.name,
      description: input.description,
      endpoint: input.endpoint,
      method: input.method,
      requestBodySchema: JSON.stringify(input.requestBodySchema),
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    if (input.headers.length > 0) {
      await this.db.createHeaders(
        input.headers.map((h) => ({
          id: newUuid(),
          toolId: id,
          headerKey: h.key,
          headerValue: h.encrypt
            ? encryptValue(h.value, this.encryptionKey!)
            : h.value,
          isEncrypted: h.encrypt,
          createdAtEpoch: now,
        })),
      );
    }

    return { id, name: input.name };
  }

  async list(userId: string): Promise<IListHttpQueryToolsOutput[]> {
    const tools = await this.db.findActiveByUser(userId);
    return Promise.all(
      tools.map(async (t) => {
        const headers = await this.db.getHeaders(t.id);
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          endpoint: t.endpoint,
          method: t.method,
          requestBodySchema: JSON.parse(t.requestBodySchema) as Record<string, unknown>,
          headers: headers.map((h) => ({ key: h.headerKey, isEncrypted: h.isEncrypted })),
          createdAtEpoch: t.createdAtEpoch,
        };
      }),
    );
  }

  async deactivate(id: string, userId: string): Promise<void> {
    const tool = await this.db.findById(id);
    if (!tool) throw new Error("TOOL_NOT_FOUND");
    if (tool.userId !== userId) throw new Error("TOOL_FORBIDDEN");
    await this.db.deactivate(id, userId);
  }
}
```

---

## Step 7 — Drizzle repository

**File:** `src/adapters/implementations/output/sqlDB/repositories/httpQueryTool.repo.ts`

```typescript
import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema";
import { httpQueryTools, httpQueryToolHeaders } from "../schema";
import type {
  IHttpQueryToolDB,
  IHttpQueryTool,
  IHttpQueryToolHeader,
  ICreateHttpQueryTool,
  ICreateHttpQueryToolHeader,
} from "../../../../../use-cases/interface/output/repository/httpQueryTool.repo";
import { newCurrentUTCEpoch } from "../../../../../helpers/time/dateTime";

export class DrizzleHttpQueryToolRepo implements IHttpQueryToolDB {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async create(tool: ICreateHttpQueryTool): Promise<void> {
    await this.db.insert(httpQueryTools).values(tool);
  }

  async createHeaders(headers: ICreateHttpQueryToolHeader[]): Promise<void> {
    if (headers.length === 0) return;
    await this.db.insert(httpQueryToolHeaders).values(headers);
  }

  async findActiveByUser(userId: string): Promise<IHttpQueryTool[]> {
    return this.db
      .select()
      .from(httpQueryTools)
      .where(and(eq(httpQueryTools.userId, userId), eq(httpQueryTools.isActive, true)));
  }

  async findById(id: string): Promise<IHttpQueryTool | null> {
    const rows = await this.db
      .select()
      .from(httpQueryTools)
      .where(eq(httpQueryTools.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getHeaders(toolId: string): Promise<IHttpQueryToolHeader[]> {
    return this.db
      .select()
      .from(httpQueryToolHeaders)
      .where(eq(httpQueryToolHeaders.toolId, toolId));
  }

  async deactivate(id: string, _userId: string): Promise<void> {
    await this.db
      .update(httpQueryTools)
      .set({ isActive: false, updatedAtEpoch: newCurrentUTCEpoch() })
      .where(eq(httpQueryTools.id, id));
  }
}
```

---

## Step 8 — Expose repo in `DrizzleSqlDB`

**File:** `src/adapters/implementations/output/sqlDB/drizzleSqlDb.adapter.ts`

Add `httpQueryTools` to the returned object:

```typescript
import { DrizzleHttpQueryToolRepo } from "./repositories/httpQueryTool.repo";
// ...in the class body or returned object:
httpQueryTools: new DrizzleHttpQueryToolRepo(db),
```

Follow the exact same pattern as other repos exposed on the same adapter (e.g., `toolManifests`, `userProfiles`).

---

## Step 9 — Tool implementation: `HttpQueryTool`

**File:** `src/adapters/implementations/output/tools/httpQuery.tool.ts`

```typescript
import { z } from "zod";
import { decryptValue } from "../../../../helpers/crypto/aes";
import { toErrorMessage } from "../../../../helpers/errors/toErrorMessage";
import type { ITool, IToolDefinition, IToolInput, IToolOutput } from "../../../../use-cases/interface/output/tool.interface";
import type { IHttpQueryTool, IHttpQueryToolHeader } from "../../../../use-cases/interface/output/repository/httpQueryTool.repo";
import type { IUserProfileCache } from "../../../../use-cases/interface/output/cache/userProfile.cache";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ILLMOrchestrator } from "../../../../use-cases/interface/output/orchestrator.interface";

export class HttpQueryTool implements ITool {
  constructor(
    private readonly toolConfig: IHttpQueryTool,
    private readonly headers: IHttpQueryToolHeader[],
    private readonly userId: string,
    private readonly userProfileCache: IUserProfileCache,
    private readonly userProfileDB: IUserProfileDB,
    private readonly orchestrator: ILLMOrchestrator,
    private readonly encryptionKey?: string,
  ) {}

  definition(): IToolDefinition {
    const schema = JSON.parse(this.toolConfig.requestBodySchema) as Record<string, unknown>;
    return {
      name: this.toolConfig.name,
      description: this.toolConfig.description,
      inputSchema: schema,
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    try {
      // 1. Collect user context from Redis + DB
      const [privyProfile, dbProfile] = await Promise.all([
        this.userProfileCache.get(this.userId).catch(() => null),
        this.userProfileDB.findByUserId(this.userId).catch(() => null),
      ]);

      const userContext: Record<string, unknown> = {
        walletAddress: dbProfile?.smartAccountAddress ?? dbProfile?.eoaAddress ?? null,
        email: privyProfile?.email ?? null,
        googleEmail: privyProfile?.googleEmail ?? null,
        telegramUserId: privyProfile?.telegramUserId ?? null,
        embeddedWalletAddress: privyProfile?.embeddedWalletAddress ?? null,
        linkedExternalWallets: privyProfile?.linkedExternalWallets ?? [],
      };

      // 2. Marshal request body via LLM
      const requestBodySchema = JSON.parse(this.toolConfig.requestBodySchema) as Record<string, unknown>;
      const marshalPrompt = [
        "You are a JSON request body builder. Given the JSON schema, the provided tool parameters, and user context, produce a complete and valid JSON request body for the HTTP call.",
        "Output ONLY the JSON object — no explanation, no markdown.",
        "",
        "JSON Schema:",
        JSON.stringify(requestBodySchema, null, 2),
        "",
        "Tool parameters (from user query):",
        JSON.stringify(input, null, 2),
        "",
        "User context (authoritative — prefer these values for user-specific fields):",
        JSON.stringify(userContext, null, 2),
      ].join("\n");

      const marshalResponse = await this.orchestrator.chat({
        systemPrompt: "You output only valid JSON objects.",
        conversationHistory: [{ role: "user", content: marshalPrompt }],
        availableTools: [],
      });

      let requestBody: unknown;
      try {
        requestBody = JSON.parse(marshalResponse.text ?? "{}");
      } catch {
        requestBody = {};
      }

      // 3. Resolve headers (decrypt encrypted ones)
      const resolvedHeaders: Record<string, string> = { "Content-Type": "application/json" };
      for (const h of this.headers) {
        const value = h.isEncrypted && this.encryptionKey
          ? decryptValue(h.headerValue, this.encryptionKey)
          : h.headerValue;
        resolvedHeaders[h.headerKey] = value;
      }

      // 4. HTTP request
      const isGet = this.toolConfig.method === "GET";
      let url = this.toolConfig.endpoint;
      let fetchBody: string | undefined;

      if (isGet) {
        const params = new URLSearchParams(
          Object.entries(requestBody as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
        url = `${url}?${params.toString()}`;
      } else {
        fetchBody = JSON.stringify(requestBody);
      }

      const httpResponse = await fetch(url, {
        method: this.toolConfig.method,
        headers: resolvedHeaders,
        ...(fetchBody !== undefined ? { body: fetchBody } : {}),
      });

      const rawText = await httpResponse.text();
      let rawJson: unknown;
      try { rawJson = JSON.parse(rawText); } catch { rawJson = rawText; }

      if (!httpResponse.ok) {
        return {
          success: false,
          error: `HTTP ${httpResponse.status}: ${typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson)}`,
        };
      }

      // 5. LLM interpret response
      const interpretPrompt = [
        "You are a data interpreter. The following is the JSON response from an external API.",
        "Summarize what the data means in clear, concise plain language suitable for a user.",
        "Output only the plain language summary — no code, no JSON, no markdown.",
        "",
        "Response:",
        typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson, null, 2),
      ].join("\n");

      const interpretResponse = await this.orchestrator.chat({
        systemPrompt: "You interpret API responses into plain language.",
        conversationHistory: [{ role: "user", content: interpretPrompt }],
        availableTools: [],
      });

      return { success: true, data: interpretResponse.text ?? JSON.stringify(rawJson) };
    } catch (err) {
      return { success: false, error: toErrorMessage(err) };
    }
  }
}
```

---

## Step 10 — Relax `IToolDefinition.name` type

**File:** `src/use-cases/interface/output/tool.interface.ts`

Change `name: TOOL_TYPE` to `name: string` in `IToolDefinition`, and `getByName(name: TOOL_TYPE)` to `getByName(name: string)`.

```typescript
export interface IToolDefinition {
  name: string;          // was TOOL_TYPE — relax to allow dynamic tool names
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface IToolRegistry {
  register(tool: ITool): void;
  getAll(): ITool[];
  getByName(name: string): ITool | undefined;  // was TOOL_TYPE
}
```

Remove the `TOOL_TYPE` import from this file if it's no longer used here.

---

## Step 11 — Update `ToolRegistryConcrete`

**File:** `src/adapters/implementations/output/toolRegistry.concrete.ts`

Change the internal `Map<TOOL_TYPE, ITool>` to `Map<string, ITool>` and update `getByName`/`register` signatures accordingly. No logic changes.

---

## Step 12 — Make `registryFactory` async in `AssistantUseCaseImpl`

**File:** `src/use-cases/implementations/assistant.usecase.ts`

### 12a — Constructor type

```typescript
private readonly registryFactory: (userId: string, conversationId: string) => Promise<IToolRegistry>,
```

### 12b — Await in `chat()`

```typescript
const toolRegistry = await this.registryFactory(input.userId, conversationId);
```

### 12c — Fix `executeTool` call — `getByName` now takes `string`

```typescript
const tool = toolRegistry.getByName(call.toolName);  // remove `as TOOL_TYPE` cast
```

The `toolName` stored in messages is already `as TOOL_TYPE` in one place — change that cast too:

```typescript
toolName: r.toolName,  // was `r.toolName as TOOL_TYPE` in messageRepo.create toolName field
```

Check the `toolName` column type in the messages schema — it's `text("tool_name")`, so any string is fine.

---

## Step 13 — Wire everything in `assistant.di.ts`

**File:** `src/adapters/inject/assistant.di.ts`

### 13a — New imports

```typescript
import { DrizzleHttpQueryToolRepo } from "../implementations/output/sqlDB/repositories/httpQueryTool.repo";
import { HttpQueryToolUseCaseImpl } from "../../use-cases/implementations/httpQueryTool.usecase";
import { HttpQueryTool } from "../implementations/output/tools/httpQuery.tool";
import type { IHttpQueryToolUseCase } from "../../use-cases/interface/input/httpQueryTool.interface";
```

### 13b — New private fields

```typescript
private _httpQueryToolUseCase: IHttpQueryToolUseCase | null = null;
```

### 13c — New getter

```typescript
getHttpQueryToolUseCase(): IHttpQueryToolUseCase {
  if (!this._httpQueryToolUseCase) {
    this._httpQueryToolUseCase = new HttpQueryToolUseCaseImpl(
      new DrizzleHttpQueryToolRepo(this.getSqlDB().db),
      process.env.HTTP_TOOL_HEADER_ENCRYPTION_KEY,
    );
  }
  return this._httpQueryToolUseCase;
}
```

**Note:** `DrizzleHttpQueryToolRepo` needs the raw `db` Drizzle instance, not `getSqlDB()` wrapper. Check how other repos get the Drizzle `db` — e.g., `DrizzleSqlDB` exposes it as `this.db` internally. If it's not currently public, add a `get db()` accessor to `DrizzleSqlDB`. Alternatively, instantiate inside `DrizzleSqlDB` and expose via `getSqlDB().httpQueryTools` (preferred — follows existing pattern).

If following the existing pattern (expose through `DrizzleSqlDB`), add `httpQueryTools: new DrizzleHttpQueryToolRepo(db)` to `DrizzleSqlDB`'s constructor and update `getHttpQueryToolUseCase()` to use `this.getSqlDB().httpQueryTools`.

### 13d — Async `registryFactory`

Change `registryFactory` inside `getUseCase()` from sync to async:

```typescript
const registryFactory = async (userId: string, conversationId: string): Promise<IToolRegistry> => {
  const r = new ToolRegistryConcrete();
  r.register(new WebSearchTool(webSearchService));
  r.register(new ExecuteIntentTool(userId, conversationId, intentUseCase));
  r.register(new GetPortfolioTool(userId, userProfileDB, tokenRegistryService, viemClient, chainId));

  // Load user's HTTP query tools from DB
  const httpToolDB = new DrizzleHttpQueryToolRepo(this.getSqlDB().db);
  const userHttpTools = await httpToolDB.findActiveByUser(userId);

  const orchestrator = new OpenAIOrchestrator(
    process.env.OPENAI_API_KEY ?? "",
    process.env.OPENAI_MODEL ?? "gpt-4o",
  );
  const userProfileCache = this.getUserProfileCache();
  const encryptionKey = process.env.HTTP_TOOL_HEADER_ENCRYPTION_KEY;

  for (const toolConfig of userHttpTools) {
    const headers = await httpToolDB.getHeaders(toolConfig.id);
    if (userProfileCache) {
      r.register(
        new HttpQueryTool(
          toolConfig,
          headers,
          userId,
          userProfileCache,
          sqlDB.userProfiles,
          orchestrator,
          encryptionKey,
        ),
      );
    }
  }

  return r;
};
```

**Note:** The `orchestrator` instance for http tool marshaling can be the same instance as the main one or a new one — either works. Using a new `OpenAIOrchestrator` per factory call is fine since it's stateless. Alternatively, hoist the main orchestrator out of the `if (!this.useCase)` block and reuse it.

Also update the `AssistantUseCaseImpl` constructor call — the type signature now expects `Promise<IToolRegistry>`:

```typescript
this.useCase = new AssistantUseCaseImpl(
  orchestrator,
  registryFactory,   // now async
  sqlDB.conversations,
  sqlDB.messages,
);
```

### 13e — Pass `httpQueryToolUseCase` to `getHttpApiServer`

```typescript
getHttpApiServer(signingRequestUseCase?: ISigningRequestUseCase): HttpApiServer {
  return new HttpApiServer(
    // ... existing args ...
    this.getUserProfileCache(),
    this.getHttpQueryToolUseCase(),   // NEW — append last
  );
}
```

---

## Step 14 — HTTP API routes

**File:** `src/adapters/implementations/input/http/httpServer.ts`

### 14a — Add import and constructor param

```typescript
import type { IHttpQueryToolUseCase } from "../../../../use-cases/interface/input/httpQueryTool.interface";
```

Append to constructor:
```typescript
private readonly httpQueryToolUseCase?: IHttpQueryToolUseCase,
```

### 14b — Register routes in `handle()`

Add before the final 404 fallback:

```typescript
if (method === "POST" && url.pathname === "/http-tools") {
  return this.handlePostHttpTool(req, res);
}
if (method === "GET" && url.pathname === "/http-tools") {
  return this.handleGetHttpTools(req, res);
}
if (method === "DELETE" && url.pathname.startsWith("/http-tools/")) {
  const id = url.pathname.split("/http-tools/")[1]?.trim() ?? "";
  return this.handleDeleteHttpTool(req, res, id);
}
```

### 14c — Handler implementations

```typescript
private async handlePostHttpTool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const userId = this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.httpQueryToolUseCase) return this.sendJson(res, 503, { error: "HTTP tool service not available" });

  let body: unknown;
  try { body = await this.readJson(req); } catch { return this.sendJson(res, 400, { error: "Invalid JSON" }); }

  const parsed = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "snake_case name required"),
    description: z.string().min(1),
    endpoint: z.string().url(),
    method: z.enum(["GET", "POST", "PUT"]),
    requestBodySchema: z.record(z.unknown()),
    headers: z.array(z.object({
      key: z.string().min(1),
      value: z.string().min(1),
      encrypt: z.boolean(),
    })).default([]),
  }).safeParse(body);

  if (!parsed.success) return this.sendJson(res, 400, { error: "Invalid request", details: parsed.error.issues });

  try {
    const result = await this.httpQueryToolUseCase.register({ userId, ...parsed.data });
    return this.sendJson(res, 201, result);
  } catch (err) {
    const msg = toErrorMessage(err);
    if (msg.startsWith("INVALID_TOOL_NAME")) return this.sendJson(res, 400, { error: msg });
    if (msg.startsWith("INVALID_ENDPOINT_URL")) return this.sendJson(res, 400, { error: msg });
    if (msg.startsWith("ENCRYPTION_KEY_NOT_CONFIGURED")) return this.sendJson(res, 503, { error: msg });
    throw err;
  }
}

private async handleGetHttpTools(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const userId = this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.httpQueryToolUseCase) return this.sendJson(res, 503, { error: "HTTP tool service not available" });

  const tools = await this.httpQueryToolUseCase.list(userId);
  return this.sendJson(res, 200, { tools });
}

private async handleDeleteHttpTool(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const userId = this.extractUserId(req);
  if (!userId) return this.sendJson(res, 401, { error: "Unauthorized" });
  if (!this.httpQueryToolUseCase) return this.sendJson(res, 503, { error: "HTTP tool service not available" });
  if (!id) return this.sendJson(res, 400, { error: "Tool ID required" });

  try {
    await this.httpQueryToolUseCase.deactivate(id, userId);
    return this.sendJson(res, 200, { id, deactivated: true });
  } catch (err) {
    const msg = toErrorMessage(err);
    if (msg === "TOOL_NOT_FOUND") return this.sendJson(res, 404, { error: msg });
    if (msg === "TOOL_FORBIDDEN") return this.sendJson(res, 403, { error: msg });
    throw err;
  }
}
```

---

## Step 15 — CORS update

The existing CORS header in `handle()` allows only `GET, POST, OPTIONS`:

```typescript
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
```

Change to:

```typescript
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
```

---

## Environment Variables

Add to `.env` (and `.env.example`):

```
# Required if any http query tool headers use encrypt: true
# Must be a 64-character hex string (32 bytes)
HTTP_TOOL_HEADER_ENCRYPTION_KEY=<generate with: openssl rand -hex 32>
```

---

## Implementation Order

1. `src/helpers/crypto/aes.ts`
2. Add tables to `src/adapters/implementations/output/sqlDB/schema.ts`
3. Generate/write migration SQL
4. `src/use-cases/interface/output/repository/httpQueryTool.repo.ts`
5. `src/use-cases/interface/input/httpQueryTool.interface.ts`
6. `src/adapters/implementations/output/sqlDB/repositories/httpQueryTool.repo.ts`
7. Expose repo in `DrizzleSqlDB`
8. `src/use-cases/implementations/httpQueryTool.usecase.ts`
9. Update `src/use-cases/interface/output/tool.interface.ts` (relax types)
10. Update `src/adapters/implementations/output/toolRegistry.concrete.ts` (Map key `string`)
11. `src/adapters/implementations/output/tools/httpQuery.tool.ts`
12. Update `src/use-cases/implementations/assistant.usecase.ts` (async registry factory)
13. Update `src/adapters/inject/assistant.di.ts` (async factory, wire new tool)
14. Update `src/adapters/implementations/input/http/httpServer.ts` (3 new routes, CORS)
15. `npx tsc --noEmit` — must be clean

---

## Guardrails

### No architecture leakage
- `HttpQueryTool` never imports grammy or any Telegram adapter.
- Encryption logic lives only in `helpers/crypto/aes.ts` — the use case and tool both import only the pure functions.
- `IHttpQueryToolUseCase` is a plain port interface; only `HttpQueryToolUseCaseImpl` knows about encryption key or DB.

### No key exposure
- The header list returned by `GET /http-tools` shows `{ key, isEncrypted }` only — never the value.
- Decrypted header values are never logged.

### Failure isolation
- If Redis is unavailable, `userProfileCache.get()` is wrapped in `.catch(() => null)` — the tool proceeds with a partial user context.
- If DB user profile is missing, wallet address will be `null`; the marshal LLM will produce a best-effort body without it.

### Tool name collision
- User-defined tool names must match `/^[a-z][a-z0-9_]{0,62}$/`. This prevents collision with system tools (`web_search`, `execute_intent`, `get_portfolio`) since those use existing names. If a user submits the same name as a system tool, the registry will have two registrations for the same name — only the last registered wins (since `Map.set` overwrites). To prevent this: add validation in `HttpQueryToolUseCaseImpl.register()` that rejects any name matching a reserved system tool name.

Reserved names to reject: `web_search`, `execute_intent`, `get_portfolio`.

### Backward compatibility
- The type change from `TOOL_TYPE` to `string` in `IToolDefinition.name` and `IToolRegistry.getByName` is backward-compatible: all `TOOL_TYPE` enum values are strings and pass through without change.
- All existing tool implementations (`WebSearchTool`, `ExecuteIntentTool`, `GetPortfolioTool`) continue to work unchanged.
