# Web Search Tool Plan

## Goal

JARVIS can answer questions about current events, live prices, recent releases, or anything
beyond its training cutoff by performing a real-time web search via Tavily. The user says something
like _"what's the latest on the Apple event?"_ or _"what's the price of ETH right now?"_ and
JARVIS searches the web, reads the results, and replies with grounded, up-to-date information.

---

## Design Decisions

- **Port interface `IWebSearchService`** — the tool depends on an interface, not the Tavily SDK
  directly. This keeps the hexagonal boundary intact and makes the search provider swappable.
- **No userId on the service** — web search is not per-user authenticated (unlike Calendar/Gmail).
  The service uses a single API key. The tool constructor does not take a `userId` argument.
- **Single tool** — Tavily's `search()` returns content snippets directly; there is no need for a
  separate "fetch page" tool. One tool call is sufficient for the LLM to get grounded results.
- **No DB schema change** — search results are ephemeral. The LLM consumes them inline and
  the assistant reply (grounded by those results) is what gets persisted as a normal message.
- **`searchDepth: "basic"`** — the default. The tool exposes no depth parameter to the LLM;
  keeping this internal avoids noise in the tool schema and prevents the LLM from requesting
  expensive `"advanced"` calls unnecessarily.
- **No try/catch in `execute()`** — consistent with `StoreUserMemoryTool`, `RetrieveUserMemoryTool`,
  `CreateTodoItemTool`, and `RetrieveTodoItemsTool`, which also call external services without
  any error handling at the tool level. The project convention is: try/catch exists only when
  there is a typed domain error class to catch and map to a user-facing `{ success: false }`.
  No such error class exists for web search, so no try/catch is used.
- **`TavilyClient` type** — `@tavily/core` must export `TavilyClient` as a named type. Verify
  before implementing Step C. If it is not exported, replace `TavilyClient` with
  `ReturnType<typeof tavily>`.

---

## Agentic Flow Overview

```
User utterance ("what happened at the Apple event?", "ETH price?", etc.)
      │
      ▼
[LLM → TOOL CALL]  web_search
  Required: query
  Optional: maxResults (default 5, capped at 5)
      │
      ▼
[TOOL]  WebSearchTool.execute()
  → TavilyWebSearchService.search({ query, maxResults })
  → Tavily API returns up to 5 result objects { title, url, content, score }
  → Tool formats results as a numbered list and returns { success: true, data: "..." }
      │
      ▼ (tool result returned to LLM)
[LLM TEXT REPLY]
  LLM reads the search results and composes a grounded, attributed reply.
  It must cite the source URLs when stating facts drawn from results.
```

---

## Tool Definition

### Tool — `web_search`

**Purpose:** Retrieve live web search results for any query. The LLM should call this whenever
the user asks about current events, recent data, or anything that may have changed since the
model's training cutoff.

**Input schema:**
```typescript
const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The search query. Be specific. Include dates or context terms if the user mentioned them " +
      "(e.g. 'Apple WWDC 2026 announcements' rather than just 'Apple')."
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(5)
    .describe("Number of results to return. Default is 5. Max is 5."),
});
```

**Output (IToolOutput.data):** Formatted string for LLM consumption, e.g.:
```
1. Apple Announces Vision Pro 2 at WWDC 2026
   URL: https://www.apple.com/newsroom/...
   Apple unveiled Vision Pro 2 with a new M5 chip and 40% lighter form factor...

2. WWDC 2026 Recap: Everything Announced
   URL: https://9to5mac.com/...
   A full rundown of every announcement from Apple's developer conference...
```

If no results are returned:
```
No results found for the given query.
```

---

## Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `src/use-cases/interface/output/webSearch.interface.ts` | Port: `IWebSearchService` + domain types |
| `src/adapters/implementations/output/webSearch/tavily.webSearchService.ts` | Tavily adapter implementing `IWebSearchService` |
| `src/adapters/implementations/output/tools/webSearch.tool.ts` | `WebSearchTool` implementing `ITool` |

### Modified files

| File | Change |
|------|--------|
| `src/helpers/enums/toolType.enum.ts` | Add `WEB_SEARCH = "web_search"` |
| `src/adapters/inject/assistant.di.ts` | Instantiate `TavilyWebSearchService`; register `WebSearchTool` in `registryFactory` |
| `.env.example` | Add `TAVILY_API_KEY=` |

No DB schema changes. No migrations required.

---

## Step-by-Step Implementation

---

### Step A — Install dependency

```bash
npm install @tavily/core
```

---

### Step B — `IWebSearchService` port interface

**File:** `src/use-cases/interface/output/webSearch.interface.ts`

```typescript
export interface IWebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface IWebSearchService {
  search(params: { query: string; maxResults: number }): Promise<IWebSearchResult[]>;
}
```

---

### Step C — `TavilyWebSearchService` adapter

**File:** `src/adapters/implementations/output/webSearch/tavily.webSearchService.ts`

```typescript
import { tavily } from "@tavily/core";
import type { TavilyClient } from "@tavily/core";
import type { IWebSearchResult, IWebSearchService } from "../../../../use-cases/interface/output/webSearch.interface";

export class TavilyWebSearchService implements IWebSearchService {
  private readonly client: TavilyClient;

  constructor(apiKey: string) {
    this.client = tavily({ apiKey });
  }

  async search(params: { query: string; maxResults: number }): Promise<IWebSearchResult[]> {
    const { query, maxResults } = params;
    const response = await this.client.search(query, {
      maxResults,
      searchDepth: "basic",
    });

    return response.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    }));
  }
}
```

---

### Step D — `TOOL_TYPE` enum

**File:** `src/helpers/enums/toolType.enum.ts` — add one value:

```typescript
WEB_SEARCH = "web_search",
```

---

### Step E — `WebSearchTool`

**File:** `src/adapters/implementations/output/tools/webSearch.tool.ts`

```typescript
import { z } from "zod";
import { TOOL_TYPE } from "../../../../helpers/enums/toolType.enum";
import type {
  ITool,
  IToolDefinition,
  IToolInput,
  IToolOutput,
} from "../../../../use-cases/interface/output/tool.interface";
import type { IWebSearchService } from "../../../../use-cases/interface/output/webSearch.interface";

const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The search query. Be specific. Include dates or context terms if the user mentioned them " +
      "(e.g. 'Apple WWDC 2026 announcements' rather than just 'Apple')."
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(5)
    .describe("Number of results to return. Default is 5. Max is 5."),
});

export class WebSearchTool implements ITool {
  constructor(private readonly webSearchService: IWebSearchService) {}

  definition(): IToolDefinition {
    return {
      name: TOOL_TYPE.WEB_SEARCH,
      description:
        "Search the web for up-to-date information. Use this when the user asks about " +
        "current events, recent news, live prices, product releases, or anything that may " +
        "have changed since your training cutoff. Always cite source URLs in your reply.",
      inputSchema: z.toJSONSchema(InputSchema),
    };
  }

  async execute(input: IToolInput): Promise<IToolOutput> {
    const { query, maxResults } = InputSchema.parse(input);
    const results = await this.webSearchService.search({ query, maxResults });

    if (results.length === 0) {
      return { success: true, data: "No results found for the given query." };
    }

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`)
      .join("\n\n");

    return { success: true, data: formatted };
  }
}
```

---

### Step F — DI wiring

**File:** `src/adapters/inject/assistant.di.ts`

Add import:
```typescript
import { TavilyWebSearchService } from "../implementations/output/webSearch/tavily.webSearchService";
import { WebSearchTool } from "../implementations/output/tools/webSearch.tool";
```

Inside `getUseCase()`, after the `gmailService` instantiation, add:
```typescript
const webSearchService = new TavilyWebSearchService(
  process.env.TAVILY_API_KEY ?? "",
);
```

Inside `registryFactory(userId)`, add:
```typescript
r.register(new WebSearchTool(webSearchService));
```

---

### Step G — Environment variable

**File:** `.env.example` — add:
```
TAVILY_API_KEY=
```

---

## System Prompt Guidance

Add to the JARVIS system prompt (via `npm run jarvis`):

```
When the user asks about current events, recent news, live prices, sports scores, product
releases, or anything that may have changed since your training cutoff:
1. Use web_search with a specific, well-formed query.
2. Read the results carefully and compose a grounded reply.
3. Cite the source URL(s) for any fact you state from the results.
4. If the results do not contain enough information, say so — do not fabricate.
```

---

## What is explicitly NOT in scope

- Full page fetching / scraping (Tavily content snippets are sufficient for most queries)
- Image search
- News-specific or domain-restricted search (use the query string for that)
- Caching search results
- Exposing `searchDepth: "advanced"` to the LLM (cost control — kept internal)
