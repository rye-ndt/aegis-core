import OpenAI from "openai";
import { createOpenRouterClient } from "../../../../helpers/llm/openrouterClient";
import { createHash } from "node:crypto";
import { createLogger } from "../../../../helpers/observability/logger";
import type { RedisResponseCache } from "../../../../helpers/cache/redisResponseCache";
import type {
  IIntentInterpreter,
  InterpreterInput,
} from "../../../../use-cases/interface/output/intentInterpreter.interface";

const log = createLogger("intentInterpreter");

// Reasoning-capable OpenRouter models (e.g. openai/gpt-5-mini) routinely
// exceed the prior 2s cap on cold paths because reasoning tokens are produced
// before any user-visible content. Below this the result-card italic note
// silently disappears; cache hits remain sub-millisecond.
const TIMEOUT_MS = 5000;
const CACHE_TTL_SEC = 300;
const MAX_WORDS = 25;

const SYSTEM_TEMPLATE = `You are Aegis, a friendly crypto assistant for Southeast Asian retail users.
Given the result of a {verb} action, write ONE sentence explaining what just
happened in plain English a teenager would understand.

Rules:
- ≤ ${MAX_WORDS} words.
- No jargon: do not say "calldata", "slippage", "gas", "AMM", "approval", "rebalance".
- Never include numbers the user didn't already see in the fields.
- No emojis.
- Past tense for success/failed.

Status: {status}
Fields:
{fields}
Extra context (JSON): {context}`;

export interface OpenAIIntentInterpreterOptions {
  model: string;
  cache?: RedisResponseCache;
}

export class OpenAIIntentInterpreter implements IIntentInterpreter {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly cache?: RedisResponseCache;

  constructor(opts: OpenAIIntentInterpreterOptions) {
    this.client = createOpenRouterClient();
    this.model = opts.model;
    this.cache = opts.cache;
  }

  async interpret(input: InterpreterInput): Promise<string | null> {
    const startedAt = Date.now();
    const cacheKey = buildCacheKey(input);
    log.debug({ step: "started", verb: input.verb, status: input.status }, "interpret-started");

    if (this.cache) {
      try {
        const hit = await this.cache.get<string>(cacheKey);
        if (hit) {
          log.debug(
            {
              verb: input.verb,
              status: input.status,
              choice: "hit",
              durationMs: Date.now() - startedAt,
            },
            "interpret-cache",
          );
          return hit;
        }
      } catch (err) {
        log.debug({ err }, "cache lookup failed");
      }
    }

    const prompt = renderPrompt(input);

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), TIMEOUT_MS);
      });
      const note = await Promise.race([this.callModel(prompt), timeout]);
      clearTimeout(timeoutHandle);

      if (!note) {
        log.warn(
          { verb: input.verb, status: input.status, durationMs: Date.now() - startedAt },
          "interpret-timeout-or-empty",
        );
        return null;
      }

      const cleaned = clampSentence(note);
      if (this.cache) {
        try {
          await this.cache.set(cacheKey, cleaned, CACHE_TTL_SEC);
        } catch (err) {
          log.debug({ err }, "cache write failed");
        }
      }
      log.info(
        {
          step: "succeeded",
          verb: input.verb,
          status: input.status,
          durationMs: Date.now() - startedAt,
          choice: "miss",
        },
        "interpret-succeeded",
      );
      return cleaned;
    } catch (err) {
      clearTimeout(timeoutHandle);
      log.warn(
        { err, verb: input.verb, status: input.status, durationMs: Date.now() - startedAt, step: "failed" },
        "interpret-failed",
      );
      return null;
    }
  }

  private async callModel(prompt: string): Promise<string | null> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "system", content: prompt }],
      // Reasoning models consume tokens silently for chain-of-thought, so a
      // tight cap can yield empty user-visible content. Keep this loose.
      max_tokens: 300,
      temperature: 0.4,
    });
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    return text.length > 0 ? text : null;
  }
}

function renderPrompt(input: InterpreterInput): string {
  const fieldLines = input.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
  const ctx = input.interpreterContext ? JSON.stringify(input.interpreterContext) : "{}";
  return SYSTEM_TEMPLATE.replace("{verb}", input.verb)
    .replace("{status}", input.status)
    .replace("{fields}", fieldLines || "(none)")
    .replace("{context}", ctx);
}

function buildCacheKey(input: InterpreterInput): string {
  const payload = JSON.stringify({
    v: input.verb,
    s: input.status,
    f: input.fields,
    c: input.interpreterContext ?? null,
  });
  const hash = createHash("sha256").update(payload).digest("hex");
  return `interp:${hash}`;
}

function clampSentence(s: string): string {
  // Strip leading/trailing quotes, collapse whitespace, enforce word cap.
  const flat = s.replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "").trim();
  const words = flat.split(" ");
  if (words.length <= MAX_WORDS) return flat;
  return words.slice(0, MAX_WORDS).join(" ") + "…";
}
