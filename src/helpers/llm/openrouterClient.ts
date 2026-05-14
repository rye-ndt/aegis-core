import OpenAI from "openai";
import type { ResponseFormatJSONSchema } from "openai/resources/shared";
import { openaiLimiter } from "../concurrency/openaiLimiter";
import {
  OPENROUTER_API_KEY,
  OPENROUTER_APP_TITLE,
  OPENROUTER_BASE_URL,
  OPENROUTER_REFERER,
} from "../env/openaiEnv";
import { createLogger } from "../observability/logger";

const log = createLogger("openrouterClient");

export function isOpenRouterConfigured(): boolean {
  return !!OPENROUTER_API_KEY;
}

export function createOpenRouterClient(): OpenAI {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      ...(OPENROUTER_REFERER ? { "HTTP-Referer": OPENROUTER_REFERER } : {}),
      ...(OPENROUTER_APP_TITLE ? { "X-Title": OPENROUTER_APP_TITLE } : {}),
    },
  });
}

// OpenAI SDK types omit OpenRouter's `provider` field. We attach this AFTER
// the literal is built so the SDK's parse-shape inference is preserved. The
// return type widens `T` to include the hint so call sites that introspect
// the body don't lose track of the extra field at the type level.
type RouterHints = { provider: { require_parameters: true } };

export function withRouterHints<T extends object>(body: T): T & RouterHints {
  // Fresh object per call — never reuse the singleton so callers can mutate
  // their body freely.
  return Object.assign(body, {
    provider: { require_parameters: true },
  }) as T & RouterHints;
}

const RETRY_NUDGE =
  "Your previous output was not valid JSON for the schema. Retry, returning ONLY the JSON object.";

interface JsonSchemaRetryArgs {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  userMessage: string;
  jsonSchema: ResponseFormatJSONSchema;
  maxAttempts?: number;
  logCtx: Record<string, unknown>;
}

/**
 * Two-pass json-schema completion.
 *
 * Error handling has two layers:
 *  - **Transport / API errors** (`OpenAI.APIError`): logged at `error`, and
 *    we fail fast on 401/403/404 since retrying won't help. Other 4xx/5xx
 *    are retried up to `maxAttempts`.
 *  - **Parse errors** (model returned non-JSON or schema-invalid JSON):
 *    logged at `warn`, retried with an appended nudge that echoes the bad
 *    output back as an assistant turn so the model sees what it produced.
 *
 * Returns the parsed object plus the raw string for diagnostic logging, or
 * `{ parsed: null, raw }` after exhaustion.
 */
export async function callJsonSchemaWithRetry<T>(
  args: JsonSchemaRetryArgs,
): Promise<{ parsed: T; raw: string } | { parsed: null; raw: string }> {
  const maxAttempts = args.maxAttempts ?? 2;
  let raw = "";
  let lastBadOutput: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Build the message sequence. On retry, include the prior bad output as
    // an assistant turn before the user nudge — two consecutive user turns
    // can be handled oddly by some OpenRouter-routed providers.
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userMessage },
    ];
    if (attempt > 1 && lastBadOutput !== null) {
      messages.push({ role: "assistant", content: lastBadOutput });
      messages.push({ role: "user", content: RETRY_NUDGE });
    }

    let completion: Awaited<
      ReturnType<typeof args.client.chat.completions.create>
    >;
    try {
      completion = await openaiLimiter(() =>
        args.client.chat.completions.create(
          withRouterHints({
            model: args.model,
            messages,
            response_format: args.jsonSchema,
          }),
        ),
      );
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        const failFast = err.status === 401 || err.status === 403 || err.status === 404;
        log.error(
          {
            ...args.logCtx,
            attempt,
            status: err.status,
            code: err.code,
            type: err.type,
            err: err.message,
          },
          "json-schema api error",
        );
        if (failFast) return { parsed: null, raw };
        continue;
      }
      log.error({ ...args.logCtx, attempt, err }, "json-schema transport error");
      continue;
    }

    raw = completion.choices[0]?.message?.content ?? "";
    try {
      return { parsed: JSON.parse(raw) as T, raw };
    } catch (err) {
      lastBadOutput = raw;
      log.warn(
        { ...args.logCtx, attempt, err, rawPrefix: raw.slice(0, 120) },
        "json-schema parse failed",
      );
    }
  }
  return { parsed: null, raw };
}
