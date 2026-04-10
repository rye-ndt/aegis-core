# Tool RAG Indexing Plan

## Goal

When a tool is registered via `POST /tools`, embed its text into Pinecone so it can be
retrieved semantically. Replace the naive ILIKE `search()` in `DrizzleToolManifestRepo`
with a vector search backed by the existing `IVectorStore` + `IEmbeddingService` infrastructure.
Gracefully degrade to ILIKE when the index is not configured.

---

## Current State (what exists)

| What | Where |
|------|--------|
| `IVectorStore` interface | `src/use-cases/interface/output/vectorDB.interface.ts` |
| `PineconeVectorStore` impl | `src/adapters/implementations/output/vectorDB/pinecone.ts` |
| `IEmbeddingService` interface | `src/use-cases/interface/output/embedding.interface.ts` |
| `OpenAIEmbeddingService` impl | `src/adapters/implementations/output/embedding/openai.ts` (model: `text-embedding-3-small`, dim: 1536) |
| Naive ILIKE search | `DrizzleToolManifestRepo.search()` line 70, marked `//todo: naive tool filter. fix this with RAG` |
| Tool registration use case | `src/use-cases/implementations/toolRegistration.usecase.ts` |
| Discovery call site | `IntentUseCaseImpl.discoverRelevantTools()` — `intent.usecase.ts:439` |
| DI container | `src/adapters/inject/assistant.di.ts` |

### What must NOT change

- The `resolveConflicts()` logic in `intent.usecase.ts` — it is already correct.
- The `ToolRegistrationUseCase.register()` validation chain (Zod → reserved-id → collision → abi_encode address check) — these guardrails stay intact and run before any indexing.
- The hexagonal architecture: use cases depend only on interfaces; adapters never depend on each other.
- The `IToolManifestDB.search()` signature — existing callers (Telegram handler) must not break.

---

## Architecture of the Change

```
POST /tools
  → HttpApiServer.handlePostTools()
  → ToolRegistrationUseCase.register()
      1. Zod validate
      2. Reserved-id guard
      3. Collision check (DB)
      4. abi_encode address validate
      5. toolManifestDB.create()       ← unchanged
      6. toolIndexService.index()      ← NEW (best-effort; failure = warning, not error)
      7. return { toolId, id, createdAt, indexed: boolean }

User message → IntentUseCaseImpl.discoverRelevantTools()
  → toolIndexService.search()          ← NEW: embed query → Pinecone → toolIds
  → toolManifestDB.findByToolIds()     ← NEW: batch DB fetch by toolId
  → resolveConflicts()                 ← unchanged
  (fallback: if toolIndexService absent or throws → toolManifestDB.search() ILIKE)
```

---

## Step-by-Step Implementation

### Step 1 — New interface: `IToolIndexService`

**New file:** `src/use-cases/interface/output/toolIndex.interface.ts`

```typescript
export interface IToolIndexService {
  /**
   * Embeds the tool text and upserts it into the vector store.
   * Uses the DB record `id` (UUID) as the Pinecone vector id.
   * Stores `toolId`, `category`, and `chainIds` in metadata for post-filter.
   */
  index(params: {
    id: string;
    toolId: string;
    text: string;
    category: string;
    chainIds: number[];
  }): Promise<void>;

  /**
   * Embeds `query` and returns semantically similar tools, ordered by score desc.
   * Post-filters by chainId if provided.
   * Only returns results with score >= minScore (default 0.3).
   */
  search(
    query: string,
    options: { topK: number; chainId?: number; minScore?: number },
  ): Promise<{ toolId: string; score: number }[]>;

  /**
   * Removes the vector from the store. Called when a tool is deactivated.
   * `id` is the DB record UUID — same value used during index().
   */
  delete(id: string): Promise<void>;
}
```

**Why a new interface instead of extending `IVectorStore` directly:**
The use cases must depend on purpose-built ports, not generic infrastructure interfaces.
`IToolIndexService` encapsulates the embed + filter logic so the use case never touches
`IVectorStore` or `IEmbeddingService` directly — consistent with every other port in the system.

---

### Step 2 — New implementation: `PineconeToolIndexService`

**New file:** `src/adapters/implementations/output/toolIndex/pinecone.toolIndex.ts`

```typescript
import type { IEmbeddingService } from "../../../../use-cases/interface/output/embedding.interface";
import type { IVectorStore } from "../../../../use-cases/interface/output/vectorDB.interface";
import type { IToolIndexService } from "../../../../use-cases/interface/output/toolIndex.interface";

const DEFAULT_MIN_SCORE = 0.3;

export class PineconeToolIndexService implements IToolIndexService {
  constructor(
    private readonly embeddingService: IEmbeddingService,
    private readonly vectorStore: IVectorStore,
  ) {}

  async index(params: {
    id: string;
    toolId: string;
    text: string;
    category: string;
    chainIds: number[];
  }): Promise<void> {
    const { vector } = await this.embeddingService.embed({ text: params.text });
    await this.vectorStore.upsert({
      id: params.id,
      vector,
      metadata: {
        toolId: params.toolId,
        category: params.category,
        // Stored as comma-separated string for simple client-side filtering.
        // Pinecone metadata filter on arrays requires $in operator which IVectorStore
        // does not expose — filter client-side after retrieval instead.
        chainIds: params.chainIds.join(","),
      },
    });
  }

  async search(
    query: string,
    options: { topK: number; chainId?: number; minScore?: number },
  ): Promise<{ toolId: string; score: number }[]> {
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const { vector } = await this.embeddingService.embed({ text: query });

    // Fetch more than needed so post-filtering by chainId still returns enough results.
    const fetchK = options.chainId != null ? options.topK * 3 : options.topK;
    const results = await this.vectorStore.query(vector, fetchK);

    return results
      .filter((r) => {
        if (r.score < minScore) return false;
        if (options.chainId == null) return true;
        const chainIds = String(r.metadata.chainIds ?? "")
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));
        return chainIds.includes(options.chainId);
      })
      .slice(0, options.topK)
      .map((r) => ({ toolId: String(r.metadata.toolId), score: r.score }));
  }

  async delete(id: string): Promise<void> {
    await this.vectorStore.delete(id);
  }
}
```

**Key design decisions:**
- `fetchK = topK * 3` when chainId filtering is needed, so chainId post-filtering still returns
  enough results. Without this, filtering 15 results down to 3 might leave the caller with too few.
- Score threshold 0.3 is deliberately conservative — better to surface a slightly off-topic tool
  than to miss the right one. `resolveConflicts()` is the final arbiter.
- `chainIds` as comma-string is an explicit trade-off: avoids needing `$in` operator on the
  Pinecone metadata filter (which `IVectorStore` does not expose). Document this in the comment.

---

### Step 3 — Text to embed (the embedding document)

The text embedded for each tool is built from:
```
`${name}. ${description}. Protocol: ${protocolName}. Tags: ${tags.join(", ")}. Category: ${category}.`
```

This is computed inside `ToolRegistrationUseCase.register()` using fields already available
on the `ToolManifest` object — **no new imports or dependencies** needed for this calculation.

Do NOT embed `steps` or `inputSchema` JSON — they are noisy and irrelevant to semantic search.

---

### Step 4 — Modify `ToolRegistrationUseCase`

**File:** `src/use-cases/implementations/toolRegistration.usecase.ts`

**Change the constructor signature** to accept optional `toolIndexService`:

```typescript
constructor(
  private readonly toolManifestDB: IToolManifestDB,
  private readonly toolIndexService?: IToolIndexService,
) {}
```

**After `toolManifestDB.create()` in `register()`**, add best-effort indexing:

```typescript
// Build the embedding document from human-readable fields only.
const embeddingText = [
  manifest.name,
  manifest.description,
  `Protocol: ${manifest.protocolName}`,
  `Tags: ${manifest.tags.join(", ")}`,
  `Category: ${manifest.category}`,
].join(". ");

let indexed = false;
if (this.toolIndexService) {
  try {
    await this.toolIndexService.index({
      id,
      toolId: manifest.toolId,
      text: embeddingText,
      category: manifest.category,
      chainIds: manifest.chainIds,
    });
    indexed = true;
  } catch (err) {
    // Indexing failure must never block tool registration. The tool is already
    // persisted in the DB and fully functional for ILIKE fallback search.
    // Log and continue — operators can reindex manually later.
    console.error(`[ToolRegistrationUseCase] Failed to index tool "${manifest.toolId}" in vector store:`, err);
  }
}

return { toolId: manifest.toolId, id, createdAt: now, indexed };
```

**Add `deactivate()` method** to the class:

```typescript
async deactivate(toolId: string): Promise<void> {
  const record = await this.toolManifestDB.findByToolId(toolId);
  if (!record) throw new Error(`Tool not found: ${toolId}`);

  await this.toolManifestDB.deactivate(toolId);

  if (this.toolIndexService) {
    try {
      await this.toolIndexService.delete(record.id);
    } catch (err) {
      // Log but do not throw — DB deactivation already committed.
      console.error(`[ToolRegistrationUseCase] Failed to delete tool "${toolId}" from vector store:`, err);
    }
  }
}
```

**Guardrail:** `deactivate()` uses the DB `id` (UUID) — not `toolId` — as the Pinecone vector id.
This matches what was stored during `index()`. Never use `toolId` as the Pinecone vector id
because it is a mutable slug (reserved-id check only prevents collisions at creation time).

---

### Step 5 — Update `RegisterToolResult`

**File:** `src/use-cases/interface/input/toolRegistration.interface.ts`

Add `indexed` and `deactivate` to the interface:

```typescript
export interface RegisterToolResult {
  toolId:    string;
  id:        string;
  createdAt: number;
  indexed:   boolean;   // true if vector store indexing succeeded
}

export interface IToolRegistrationUseCase {
  register(manifest: ToolManifest): Promise<RegisterToolResult>;
  list(chainId?: number): Promise<ToolManifest[]>;
  deactivate(toolId: string): Promise<void>;
}
```

---

### Step 6 — Add `findByToolIds` to `IToolManifestDB`

**File:** `src/use-cases/interface/output/repository/toolManifest.repo.ts`

Add to the interface:

```typescript
findByToolIds(toolIds: string[]): Promise<IToolManifestRecord[]>;
```

**File:** `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts`

Implement using Drizzle's `inArray`:

```typescript
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";

async findByToolIds(toolIds: string[]): Promise<IToolManifestRecord[]> {
  if (toolIds.length === 0) return [];
  const rows = await this.db
    .select()
    .from(toolManifests)
    .where(and(eq(toolManifests.isActive, true), inArray(toolManifests.toolId, toolIds)));
  return rows.map((r) => this.toRecord(r));
}
```

**Guardrail:** Guard `toolIds.length === 0` explicitly — `inArray` with an empty array generates
invalid SQL in Drizzle and throws a runtime error.

---

### Step 7 — Replace `discoverRelevantTools` in `IntentUseCaseImpl`

**File:** `src/use-cases/implementations/intent.usecase.ts`

**Change the constructor** to accept optional `toolIndexService`:

```typescript
constructor(
  // ... existing params ...
  private readonly toolManifestDB: IToolManifestDB,
  private readonly toolIndexService?: IToolIndexService,
) {}
```

**Replace `discoverRelevantTools()`:**

```typescript
private async discoverRelevantTools(rawInput: string): Promise<ToolManifest[]> {
  // --- Vector search path ---
  if (this.toolIndexService) {
    try {
      const hits = await this.toolIndexService.search(rawInput, {
        topK: 20,
        chainId: this.chainId,
        minScore: 0.3,
      });

      if (hits.length > 0) {
        const toolIds = hits.map((h) => h.toolId);
        const records = await this.toolManifestDB.findByToolIds(toolIds);

        // Preserve the vector score ordering from Pinecone before resolveConflicts
        // reorders by category. Build a score map so resolveConflicts can use it
        // if needed in future — for now just preserve insertion order.
        const scoreMap = new Map(hits.map((h) => [h.toolId, h.score]));
        records.sort((a, b) => (scoreMap.get(b.toolId) ?? 0) - (scoreMap.get(a.toolId) ?? 0));

        return this.resolveConflicts(records, rawInput);
      }
      // hits.length === 0 means no semantically relevant tool found — return empty,
      // do NOT fall back to ILIKE (ILIKE returning garbage is worse than returning nothing).
      return [];
    } catch (err) {
      // Vector search failed (Pinecone down, network issue, etc.).
      // Fall through to ILIKE with a warning log — degraded but functional.
      console.error("[IntentUseCaseImpl] Vector search failed, falling back to ILIKE:", err);
    }
  }

  // --- ILIKE fallback path (used when toolIndexService is absent or threw) ---
  const candidates = await this.toolManifestDB.search(rawInput, {
    limit: 15,
    chainId: this.chainId,
  });
  return this.resolveConflicts(candidates, rawInput);
}
```

**Why fall back only on error, not on empty results:**
If the vector store returns 0 results with score >= 0.3, it means no tool is semantically
relevant to the query. Falling back to ILIKE in that case would surface unrelated tools
(substring hits on common words like "token", "swap") and inject noise into the LLM prompt.
An empty result is the correct signal — the system handles it already (no manifest → no
dynamic tool offered to the LLM).

---

### Step 8 — Add `DELETE /tools/:toolId` to the HTTP server

**File:** `src/adapters/implementations/input/http/httpServer.ts`

Add a new route in the `handle()` dispatcher:

```typescript
if (method === "DELETE" && url.pathname.startsWith("/tools/")) {
  return this.handleDeleteTool(req, res, url);
}
```

Implement the handler. This endpoint requires JWT auth (same as `POST /tools`):

```typescript
private async handleDeleteTool(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const userId = this.extractUserId(req);
  if (!userId) {
    this.sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (!this.toolRegistrationUseCase) {
    this.sendJson(res, 503, { error: "Tool registry not configured" });
    return;
  }
  const toolId = url.pathname.split("/tools/")[1]?.trim();
  if (!toolId) {
    this.sendJson(res, 400, { error: "toolId is required" });
    return;
  }
  try {
    await this.toolRegistrationUseCase.deactivate(toolId);
    this.sendJson(res, 200, { toolId, deactivated: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("Tool not found") ? 404 : 500;
    this.sendJson(res, status, { error: message });
  }
}
```

---

### Step 9 — Wire everything in the DI container

**File:** `src/adapters/inject/assistant.di.ts`

Add imports:
```typescript
import { OpenAIEmbeddingService } from "../implementations/output/embedding/openai";
import { PineconeVectorStore } from "../implementations/output/vectorDB/pinecone";
import { PineconeToolIndexService } from "../implementations/output/toolIndex/pinecone.toolIndex";
import type { IToolIndexService } from "../../use-cases/interface/output/toolIndex.interface";
```

Add private fields:
```typescript
private _embeddingService: OpenAIEmbeddingService | null = null;
private _toolVectorStore: PineconeVectorStore | null = null;
private _toolIndexService: IToolIndexService | null = null;
```

Add factory methods:

```typescript
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

getToolIndexService(): IToolIndexService | null {
  const embeddingService = this.getEmbeddingService();
  const vectorStore = this.getToolVectorStore();
  if (!embeddingService || !vectorStore) return null;
  if (!this._toolIndexService) {
    this._toolIndexService = new PineconeToolIndexService(embeddingService, vectorStore);
  }
  return this._toolIndexService;
}
```

**Update `getToolRegistrationUseCase()`:**
```typescript
getToolRegistrationUseCase(): IToolRegistrationUseCase {
  if (!this._toolRegistrationUseCase) {
    this._toolRegistrationUseCase = new ToolRegistrationUseCase(
      this.getSqlDB().toolManifests,
      this.getToolIndexService() ?? undefined,   // undefined = ILIKE fallback
    );
  }
  return this._toolRegistrationUseCase;
}
```

**Update `getIntentUseCase()`** — pass `toolIndexService` as the last argument:
```typescript
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
  this.getToolIndexService() ?? undefined,  // NEW — last param
);
```

**Guardrail:** `getToolIndexService()` returns `null` when env vars are missing. The callers
coerce `null → undefined` so the use cases receive `undefined` (typed as `IToolIndexService | undefined`)
and branch to the ILIKE fallback. This means the system starts without Pinecone credentials and
everything still works.

---

### Step 10 — Environment variables

**File:** `.env.example` — add if not already present:

```
OPENAI_API_KEY=sk-...          # also used by OpenAIIntentParser — already required
PINECONE_API_KEY=...
PINECONE_INDEX_NAME=onchain-tools
PINECONE_HOST=https://<index-id>.svc.<region>.pinecone.io   # optional — skips describe-index call
```

**Pinecone index settings (create manually in Pinecone dashboard or via CLI before first run):**
- Dimension: **1536** (matches `text-embedding-3-small`)
- Metric: **cosine**
- Type: serverless

The index name `onchain-tools` is separate from any user-memory index (from `agentic-rag-plan.md`)
to prevent metadata collisions between tool vectors and memory vectors.

---

## Complete File Change Checklist

| File | Action | Notes |
|------|--------|-------|
| `src/use-cases/interface/output/toolIndex.interface.ts` | **Create** | New port: `IToolIndexService` |
| `src/adapters/implementations/output/toolIndex/pinecone.toolIndex.ts` | **Create** | Concrete impl |
| `src/use-cases/interface/input/toolRegistration.interface.ts` | **Modify** | Add `indexed` to result; add `deactivate()` |
| `src/use-cases/implementations/toolRegistration.usecase.ts` | **Modify** | Inject service; index after create; add `deactivate()` |
| `src/use-cases/interface/output/repository/toolManifest.repo.ts` | **Modify** | Add `findByToolIds()` |
| `src/adapters/implementations/output/sqlDB/repositories/toolManifest.repo.ts` | **Modify** | Implement `findByToolIds()` using `inArray` |
| `src/use-cases/implementations/intent.usecase.ts` | **Modify** | Inject service; replace `discoverRelevantTools()` |
| `src/adapters/inject/assistant.di.ts` | **Modify** | Wire 3 new services; pass to both use cases |
| `src/adapters/implementations/input/http/httpServer.ts` | **Modify** | Add `DELETE /tools/:toolId` route |
| `.env.example` | **Modify** | Add Pinecone vars |

No new DB migrations. No changes to the Drizzle schema. No changes to `resolveConflicts()`.
No changes to the Telegram handler or any other input adapter.

---

## Guardrails and Safety Checks

### Registration safety (Step 4)
- The existing 4-step validation chain (Zod → reserved-id → collision → address check) runs
  **before** any indexing attempt. A validation failure never touches the vector store.
- Indexing is wrapped in `try/catch`. A Pinecone failure returns `{ indexed: false }` in the
  HTTP response so callers know to reindex later — but the tool is already in the DB and works.
- Never swallow an error silently: always `console.error` with the `toolId` so the failure
  is observable in logs.

### Discovery safety (Step 7)
- The vector search path is wrapped in `try/catch`. On any error, log and fall back to ILIKE.
- Zero vector results → return empty array (do NOT fall back to ILIKE). Noise from ILIKE is
  worse than no dynamic tools.
- Score threshold 0.3 prevents extremely weak matches from polluting the LLM prompt.
- `fetchK = topK * 3` prevents chainId post-filtering from starving the result set.
- `inArray` guard for empty `toolIds` array prevents a Drizzle runtime error.

### Deactivation safety (Step 4)
- DB deactivation (`toolManifestDB.deactivate()`) runs **before** vector delete.
  If vector delete fails, the tool is already inactive in DB — it will never be served.
  The stale vector in Pinecone is harmless: `findByToolIds` filters by `isActive = true`,
  so even if the vector is returned by Pinecone, the DB fetch drops it.
- Deactivating a non-existent toolId throws `"Tool not found"` before touching the vector store.

### Architecture compliance
- Use cases (`toolRegistration.usecase.ts`, `intent.usecase.ts`) depend only on `IToolIndexService`
  (interface). They never import `PineconeToolIndexService`, `OpenAIEmbeddingService`, or
  `PineconeVectorStore` directly. All wiring is in `assistant.di.ts`.
- `PineconeToolIndexService` depends on `IEmbeddingService` and `IVectorStore` (interfaces),
  not their concrete implementations. It lives in `adapters/implementations/output/toolIndex/`
  — an output adapter — consistent with every other adapter in the system.

---

## Backfill: Indexing Tools Already in the Database

Tools registered before this change are in the DB but not in Pinecone. Until backfilled,
discovery for those tools falls through to ILIKE (safe — existing behavior).

**Option A (recommended): one-shot script**

Create `scripts/backfillToolIndex.ts`:

```typescript
// scripts/backfillToolIndex.ts
import "dotenv/config";
import { AssistantInject } from "../src/adapters/inject/assistant.di";

async function main() {
  const inject = new AssistantInject();
  const db = inject.getSqlDB();
  const toolIndexService = inject.getToolIndexService();

  if (!toolIndexService) {
    console.error("Pinecone not configured — set PINECONE_API_KEY and PINECONE_INDEX_NAME");
    process.exit(1);
  }

  const records = await db.toolManifests.listActive();
  console.log(`Indexing ${records.length} tools...`);

  for (const record of records) {
    const tags = JSON.parse(record.tags) as string[];
    const embeddingText = [
      record.name,
      record.description,
      `Protocol: ${record.protocolName}`,
      `Tags: ${tags.join(", ")}`,
      `Category: ${record.category}`,
    ].join(". ");

    const chainIds = JSON.parse(record.chainIds) as number[];

    try {
      await toolIndexService.index({
        id: record.id,
        toolId: record.toolId,
        text: embeddingText,
        category: record.category,
        chainIds,
      });
      console.log(`  ✓ ${record.toolId}`);
    } catch (err) {
      console.error(`  ✗ ${record.toolId}:`, err);
    }
  }
  console.log("Done.");
  process.exit(0);
}

main();
```

Run: `npx tsx scripts/backfillToolIndex.ts`

**Option B:** Add a `POST /tools/reindex` admin endpoint that calls the same logic.
Useful if you need to trigger backfill without shell access.

---

## Verification Checklist

After implementation, verify in order:

1. **ILIKE fallback works** — set `PINECONE_API_KEY=` (empty) and register a tool via
   `POST /tools`. Confirm registration succeeds, `indexed: false` in response.
   Send a user intent — confirm ILIKE discovery still returns the tool.

2. **Tool indexing on registration** — set valid Pinecone credentials. Register a new tool.
   Confirm `indexed: true` in response. Query Pinecone directly to verify the vector exists
   with correct `toolId` in metadata.

3. **Semantic discovery replaces ILIKE** — send a user message semantically related to the
   registered tool (but not a substring match). Confirm the tool appears in the LLM prompt
   (add a temporary `console.log` in `discoverRelevantTools`). Remove the log after confirming.

4. **ChainId filtering** — register a tool with `chainIds: [1]` (mainnet). Confirm it does
   NOT appear in Fuji (chainId 43113) discovery results.

5. **Score threshold** — register a tool about an unrelated domain (e.g., NFT minting) and
   send a swap intent. Confirm the NFT tool does not appear in results.

6. **Deactivation** — call `DELETE /tools/:toolId`. Confirm: (a) `isActive = false` in DB,
   (b) vector deleted from Pinecone, (c) tool no longer appears in discovery.

7. **Pinecone failure during discovery** — temporarily break the Pinecone connection (bad host).
   Send a user intent — confirm the system logs the error and falls back to ILIKE without
   returning a 500 to the user.

8. **Pinecone failure during registration** — temporarily break the connection and register a tool.
   Confirm: (a) tool is in DB, (b) `indexed: false` in response, (c) no 500 returned.
