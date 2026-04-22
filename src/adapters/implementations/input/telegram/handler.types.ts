import type {
  ITokenRecord,
  ResolvedPayload,
  ToolManifest,
} from "../../../../use-cases/interface/input/intent.interface";

export type OrchestratorStage = "compile" | "token_disambig";

export interface DisambiguationPending {
  resolvedFrom: ITokenRecord | null;
  resolvedTo: ITokenRecord | null;
  awaitingSlot: "from" | "to";
  fromCandidates: ITokenRecord[];
  toCandidates: ITokenRecord[];
}

export interface OrchestratorSession {
  stage: OrchestratorStage;
  conversationId: string;
  messages: string[];
  manifest: ToolManifest;
  partialParams: Record<string, unknown>;
  /** Legacy: token symbols extracted by the LLM for non-dual-schema tools. */
  tokenSymbols: { from?: string; to?: string };
  /** Dual-schema: human-readable values keyed by RESOLVER_FIELD enum — fed to ResolverEngine. */
  resolverFields: Partial<Record<string, string>>;
  compileTurns: number;
  disambigTurns: number;
  resolved?: ResolvedPayload;
  disambiguation?: DisambiguationPending;
  recipientTelegramUserId?: string;
}

export type CtxLike = { reply: (text: string, opts?: object) => Promise<unknown> };
