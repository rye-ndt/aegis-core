import type { InlineKeyboard } from "grammy";
import type { INTENT_COMMAND } from "../../../helpers/enums/intentCommand.enum";
import type { MiniAppRequest } from "../output/cache/miniAppRequest.types";

/**
 * How a capability declares it wants to be reached.
 * A capability may have any combination of triggers; the dispatcher indexes
 * them and routes incoming inputs accordingly.
 */
export interface TriggerSpec {
  /** Fired when the user types this slash command as the first token. */
  command?: INTENT_COMMAND;
  /**
   * Prefix used to route Telegram callback queries back to this capability.
   * E.g. "buy" matches callback data `buy:y:50`. The capability receives the
   * full data string and parses the suffix itself.
   */
  callbackPrefix?: string;
  /**
   * Natural-language fallback weight. If no command/callback matches and the
   * dispatcher needs to route free text, it may consult these tags via RAG
   * or heuristic. A capability with no command and no tags is considered
   * "LLM-fallback only" and only fires via the registry's default route.
   */
  ragTags?: string[];
}

/**
 * Per-invocation context passed to every capability. Carries the user and
 * channel identity plus whatever plumbing `collect` or `run` may need. We
 * keep this deliberately minimal — capabilities reach other services via
 * constructor injection, not through this context bag.
 */
export interface CapabilityCtx {
  userId: string;
  /** Opaque channel identifier. For Telegram this is the chat id as string. */
  channelId: string;
  /** Raw input that triggered this invocation. */
  input: DispatchInput;
  /** For text/callback inputs: a correlation id the renderer may attach. */
  conversationId?: string;
  /**
   * Emit an intermediate artifact before collect/run returns. Used by flows
   * that need to show progress (e.g. "Resolving @handle...") or produce
   * several replies from one user input. The terminal artifact is returned
   * from run() as usual; `emit` is only for in-flight updates.
   */
  emit(artifact: Artifact): Promise<void>;
}

/** Input shapes the dispatcher accepts from any input adapter. */
export type DispatchInput =
  | { kind: "text"; text: string }
  | { kind: "callback"; data: string };

/**
 * Outcome of a `collect` call. Either we have everything we need (`ok`), or
 * we need to ask the user another question before we can run (`ask`).
 */
export type CollectResult<P> =
  | { kind: "ok"; params: P }
  | {
      kind: "ask";
      question: string;
      keyboard?: InlineKeyboard;
      parseMode?: "Markdown";
      /** Carried on the PendingCollection; passed back as `resuming` on the next call. */
      state: Record<string, unknown>;
    };

/** Discriminated union of all output shapes a capability may produce. */
export type Artifact =
  | { kind: "chat"; text: string; keyboard?: InlineKeyboard; parseMode?: "Markdown" }
  | {
      kind: "sign_calldata";
      to: string;
      data: string;
      value: string;
      description: string;
      autoSign: boolean;
    }
  | { kind: "mini_app"; request: MiniAppRequest; promptText: string; buttonText: string; fallbackText?: string }
  | { kind: "llm_data"; data: unknown }
  | { kind: "noop" };

/**
 * A feature the system exposes to users. One impl per feature. Collaborators
 * (repos, use-cases, resolvers) come in via the constructor — the
 * interface itself stays at four members by design.
 */
export interface Capability<P = unknown> {
  readonly id: string;
  readonly triggers: TriggerSpec;
  /**
   * Collect params. If more input is needed, return `ask` with state; the
   * dispatcher will persist it and re-enter `collect` with `resuming` set
   * on the next user input.
   */
  collect(ctx: CapabilityCtx, resuming?: Record<string, unknown>): Promise<CollectResult<P>>;
  /** Produce the output artifact once params are resolved. */
  run(params: P, ctx: CapabilityCtx): Promise<Artifact>;
}
