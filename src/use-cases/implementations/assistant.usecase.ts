import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { CONVERSATION_STATUSES } from "../../helpers/enums/statuses.enum";
import { MESSAGE_ROLE } from "../../helpers/enums/messageRole.enum";
import { TOOL_TYPE } from "../../helpers/enums/toolType.enum";
import type {
  IAssistantUseCase,
  IChatInput,
  IChatResponse,
  IGetConversationInput,
  IListConversationsInput,
  IVoiceChatInput,
} from "../interface/input/assistant.interface";
import type { ISpeechToText } from "../interface/output/stt.interface";
import type {
  ILLMOrchestrator,
  IOrchestratorMessage,
  IToolCall,
} from "../interface/output/orchestrator.interface";
import type { IToolRegistry } from "../interface/output/tool.interface";
import type {
  Conversation,
  IConversationDB,
} from "../interface/output/repository/conversation.repo";
import type {
  IMessageDB,
  Message,
} from "../interface/output/repository/message.repo";
import type { IJarvisConfigDB } from "../interface/output/repository/jarvisConfig.repo";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type { IEmbeddingService } from "../interface/output/embedding.interface";
import type {
  IVectorStore,
  IVectorQueryResult,
} from "../interface/output/vectorDB.interface";
import type { ITextGenerator } from "../interface/output/textGenerator.interface";
import type { IEvaluationLogDB } from "../interface/output/repository/evaluationLog.repo";
import type { IUserMemoryDB } from "../interface/output/repository/userMemory.repo";

const DEFAULT_SYSTEM_PROMPT =
  "You are JARVIS, a personal AI assistant. Be concise and helpful.";
const DEFAULT_MAX_TOOL_ROUNDS = 10;

interface IToolResult {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  result: { success: boolean; data?: unknown; error?: unknown };
  latencyMs: number;
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function buildReasoningTrace(toolsUsed: IToolResult[]): string | null {
  if (toolsUsed.length === 0) return null;
  return toolsUsed
    .map(
      (t, i) =>
        `step ${i + 1}: ${t.toolName} → ${t.result.success ? "ok" : "error"}`,
    )
    .join("\n");
}

// NOTE: Extracting reasoning from the final reply text is not viable with gpt-4o —
// the final response is just the answer. The tool call sequence above is the only
// reliable trace available.

function detectImplicitSignal(
  currentMessage: string,
  _previousResponse: string,
): string | null {
  const msg = currentMessage.toLowerCase();

  const correctionKeywords = [
    "actually,",
    "that's wrong",
    "that is wrong",
    "no,",
    "incorrect",
    "you said",
    "wait,",
    "not quite",
    "wrong,",
  ];
  const repeatKeywords = [
    "as i asked",
    "again,",
    "still need",
    "i already asked",
    "why didn't you",
    "you didn't",
  ];
  const clarificationKeywords = [
    "what do you mean",
    "can you explain",
    "i meant",
    "i was asking about",
    "clarify",
  ];

  if (correctionKeywords.some((k) => msg.includes(k))) return "correction";
  if (repeatKeywords.some((k) => msg.includes(k))) return "repeat";
  if (clarificationKeywords.some((k) => msg.includes(k)))
    return "clarification";
  return null;
}

function formatMessagesForPrompt(
  messages: Pick<Message, "role" | "content">[],
): string {
  return messages.map((m) => `[${m.role}]: ${m.content}`).join("\n");
}

export class AssistantUseCaseImpl implements IAssistantUseCase {
  constructor(
    private readonly speechToText: ISpeechToText,
    private readonly orchestrator: ILLMOrchestrator,
    private readonly registryFactory: (userId: string) => IToolRegistry,
    private readonly conversationRepo: IConversationDB,
    private readonly messageRepo: IMessageDB,
    private readonly jarvisConfigRepo: IJarvisConfigDB,
    private readonly userProfileRepo: IUserProfileDB,
    private readonly embeddingService: IEmbeddingService,
    private readonly vectorStore: IVectorStore,
    private readonly textGenerator: ITextGenerator,
    private readonly evaluationLogRepo: IEvaluationLogDB,
    private readonly userMemoryRepo: IUserMemoryDB,
  ) {}

  async voiceChat(input: IVoiceChatInput): Promise<IChatResponse> {
    const transcription = await this.speechToText.transcribe({
      audioBuffer: input.audioBuffer,
      mimeType: input.mimeType,
    });

    return this.chat({
      userId: input.userId,
      conversationId: input.conversationId,
      message: transcription.text,
    });
  }

  async chat(input: IChatInput): Promise<IChatResponse> {
    const conversationId = await this.initConversation(input);

    // User message is persisted in the parallel batch so allMessages loads
    // prior history only (concurrent INSERT not visible to concurrent SELECT
    // at READ COMMITTED isolation — intentional).
    const [allMessages, relevantMemories, config, userProfile, conversation] =
      await Promise.all([
        this.messageRepo.findByConversationId(conversationId),
        this.searchRelevantMemories(input.message, input.userId),
        this.jarvisConfigRepo.get(),
        this.userProfileRepo.findByUserId(input.userId),
        this.conversationRepo.findById(conversationId),
        this.messageRepo.create({
          id: newUuid(),
          conversationId,
          role: MESSAGE_ROLE.USER,
          content: input.message,
          createdAtEpoch: newCurrentUTCEpoch(),
        }),
      ] as const);

    const maxRounds =
      config?.maxToolRounds ??
      parseInt(process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_TOOL_ROUNDS));

    // Count only uncompressed messages — compressed messages are already in the
    // summary. Counting them would re-trigger compression every turn after the first.
    const uncompressed = allMessages.filter((m) => !m.compressedAtEpoch);
    const totalTokens = uncompressed.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0,
    );

    let recentMessages: Message[];
    let currentSummary = conversation?.summary ?? null;

    if (totalTokens > 80_000 || conversation?.flaggedForCompression) {
      const tail = uncompressed.slice(-20);
      const toCompress = uncompressed.slice(0, -20);

      if (toCompress.length > 0) {
        const newSummary = await this.textGenerator.generate(
          "You are a conversation summarizer. Extend the existing summary with the new messages. " +
            "Preserve: facts, decisions, corrections, user preferences, tool outcomes. " +
            "Discard: pleasantries, filler. Collapse tool calls into prose. " +
            "Return only the updated summary text.",
          `Existing summary:\n${currentSummary ?? "(none)"}\n\n` +
            `New messages to incorporate:\n${formatMessagesForPrompt(toCompress)}`,
        );

        await Promise.all([
          this.conversationRepo.upsertSummary(conversationId, newSummary),
          this.messageRepo.markCompressed(
            toCompress.map((m) => m.id),
            newCurrentUTCEpoch(),
          ),
        ]);

        currentSummary = newSummary;
      }

      recentMessages = tail;
    } else {
      recentMessages = uncompressed.slice(-20);
    }

    const slidingWindow: IOrchestratorMessage[] = [];

    if (currentSummary) {
      slidingWindow.push({
        role: MESSAGE_ROLE.ASSISTANT,
        content: `Summary of earlier conversation:\n${currentSummary}`,
      });
    }

    slidingWindow.push(...this.buildOrchestratorHistory(recentMessages));

    const basePrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = this.buildSystemPrompt(
      basePrompt,
      userProfile?.personalities ?? [],
      relevantMemories,
    );

    slidingWindow.push({
      role: MESSAGE_ROLE.USER,
      content: input.message,
      imageBase64Url: input.imageBase64Url,
    });

    const toolRegistry = this.registryFactory(input.userId);
    const availableTools = toolRegistry.getAll().map((t) => t.definition());
    const toolsUsed: IToolResult[] = [];
    let finalReply = "";
    let lastUsage:
      | { promptTokens: number; completionTokens: number }
      | undefined;

    for (let round = 0; round < maxRounds; round++) {
      const llmResponse = await this.orchestrator.chat({
        systemPrompt,
        conversationHistory: slidingWindow,
        availableTools,
      });

      lastUsage = llmResponse.usage;

      if (!llmResponse.toolCalls?.length) {
        finalReply = llmResponse.text ?? "";
        break;
      }

      const roundResults = await Promise.all(
        llmResponse.toolCalls.map((tc) => this.executeTool(tc, toolRegistry)),
      );

      const toolCallsJson = JSON.stringify(llmResponse.toolCalls);
      await Promise.all([
        this.messageRepo.create({
          id: newUuid(),
          conversationId,
          role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
          content: "",
          toolCallsJson,
          createdAtEpoch: newCurrentUTCEpoch(),
        }),
        ...roundResults.map((r) =>
          this.messageRepo.create({
            id: newUuid(),
            conversationId,
            role: MESSAGE_ROLE.TOOL,
            content: JSON.stringify(r.result.data ?? r.result.error),
            toolName: r.toolName as TOOL_TYPE,
            toolCallId: r.toolCallId,
            createdAtEpoch: newCurrentUTCEpoch(),
          }),
        ),
      ]);

      slidingWindow.push({
        role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
        content: "",
        toolCallsJson,
      });
      for (const r of roundResults) {
        slidingWindow.push({
          role: MESSAGE_ROLE.TOOL,
          content: JSON.stringify(r.result.data ?? r.result.error),
          toolName: r.toolName,
          toolCallId: r.toolCallId,
        });
      }

      toolsUsed.push(...roundResults);
    }

    const messageId = newUuid();
    await this.messageRepo.create({
      id: messageId,
      conversationId,
      role: MESSAGE_ROLE.ASSISTANT,
      content: finalReply,
      createdAtEpoch: newCurrentUTCEpoch(),
    });

    setImmediate(() => {
      void this.postProcess({
        conversationId,
        messageId,
        userId: input.userId,
        systemPrompt,
        relevantMemories,
        toolsUsed,
        finalReply,
        usage: lastUsage,
        slidingWindow,
        totalTokens,
        userMessage: input.message,
      });
    });

    return {
      conversationId,
      messageId,
      reply: finalReply,
      toolsUsed: toolsUsed.map((t) => t.toolName),
    };
  }

  async listConversations(
    input: IListConversationsInput,
  ): Promise<Conversation[]> {
    return this.conversationRepo.findByUserId(input.userId);
  }

  async getConversation(input: IGetConversationInput): Promise<Message[]> {
    return this.messageRepo.findByConversationId(input.conversationId);
  }

  async submitRating(messageId: string, rating: number): Promise<void> {
    await this.evaluationLogRepo.updateExplicitRating(messageId, rating);
  }

  private async initConversation(input: IChatInput): Promise<string> {
    if (input.conversationId) return input.conversationId;

    const conversationId = newUuid();
    const now = newCurrentUTCEpoch();
    await this.conversationRepo.create({
      id: conversationId,
      userId: input.userId,
      title: input.message.slice(0, 60),
      status: CONVERSATION_STATUSES.ACTIVE,
      flaggedForCompression: false,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
    return conversationId;
  }

  private async searchRelevantMemories(
    message: string,
    userId: string,
  ): Promise<IVectorQueryResult[]> {
    try {
      const { vector } = await this.embeddingService.embed({ text: message });
      const results = await this.vectorStore.query(vector, 5, { userId });
      return results.filter((r) => r.score >= 0.75);
    } catch {
      return [];
    }
  }

  private buildSystemPrompt(
    basePrompt: string,
    personalities: string[],
    memories: IVectorQueryResult[],
  ): string {
    const now = new Date();
    const parts: string[] = [basePrompt];

    if (personalities.length > 0) {
      parts.push(`Personality: ${personalities.join(", ")}.`);
    }

    parts.push(`Current datetime: ${now.toISOString()}.`);

    if (memories.length > 0) {
      const formatted = memories
        .map((m, i) => `${i + 1}. ${String(m.metadata["content"] ?? "")}`)
        .join("\n");
      parts.push(`Relevant memories about the user:\n${formatted}`);
    }

    parts.push(
      `REASONING INSTRUCTIONS:
Before calling any tool, emit a Thought explaining:
- What the user is actually asking (decompose if multiple things)
- What information you need
- Which tools you will use and in what order
- What you will do if a tool returns empty or errors

After receiving tool results, emit another Thought:
- What the result tells you
- Whether you need another tool or can respond
- If result is empty/error, reason about an alternative approach

Never skip the Thought step.`,
    );

    return parts.join("\n\n");
  }

  private async executeTool(
    call: IToolCall,
    toolRegistry: IToolRegistry,
  ): Promise<IToolResult> {
    const start = Date.now();
    const tool = toolRegistry.getByName(call.toolName as TOOL_TYPE);

    if (!tool) {
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        params: call.input,
        result: {
          success: false,
          error: `Tool "${call.toolName}" is not available.`,
        },
        latencyMs: Date.now() - start,
      };
    }

    let result = await tool.execute(call.input);

    if (!result.success) {
      // Single retry with identical params — handles transient failures only.
      // Param errors are not corrected here; the LLM sees the error result and
      // may issue a corrected call on the next loop round.
      result = await tool.execute(call.input);
    }

    return {
      toolCallId: call.id,
      toolName: call.toolName,
      params: call.input,
      result,
      latencyMs: Date.now() - start,
    };
  }

  private async postProcess(ctx: {
    conversationId: string;
    messageId: string;
    userId: string;
    systemPrompt: string;
    relevantMemories: IVectorQueryResult[];
    toolsUsed: IToolResult[];
    finalReply: string;
    usage: { promptTokens: number; completionTokens: number } | undefined;
    slidingWindow: IOrchestratorMessage[];
    totalTokens: number;
    userMessage: string;
  }): Promise<void> {
    try {
      const logId = newUuid();
      await this.evaluationLogRepo.create({
        id: logId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        userId: ctx.userId,
        systemPromptHash: hashString(ctx.systemPrompt),
        memoriesInjected: JSON.stringify(
          ctx.relevantMemories.map((m) => ({ id: m.id, score: m.score })),
        ),
        toolCalls: JSON.stringify(ctx.toolsUsed),
        reasoningTrace: buildReasoningTrace(ctx.toolsUsed),
        response: ctx.finalReply,
        promptTokens: ctx.usage?.promptTokens ?? null,
        completionTokens: ctx.usage?.completionTokens ?? null,
        implicitSignal: null,
        explicitRating: null,
        outcomeConfirmed: null,
        createdAtEpoch: newCurrentUTCEpoch(),
      });

      const prevLog = await this.evaluationLogRepo.findLastByConversation(
        ctx.conversationId,
        1,
      );
      if (prevLog) {
        const signal = detectImplicitSignal(ctx.userMessage, prevLog.response);
        if (signal) {
          await this.evaluationLogRepo.updateImplicitSignal(prevLog.id, signal);
        }
      }

      // Skip trivial turns (short reply, no tools) to avoid unnecessary LLM + embedding calls.
      // NOTE: when facts are extracted, each requires a separate embeddingService.embed() call
      // (up to 5 parallel calls per qualifying turn in the async path).
      const skipMemoryExtraction =
        ctx.finalReply.length < 100 && ctx.toolsUsed.length === 0;

      if (!skipMemoryExtraction) {
        const rawFacts = await this.textGenerator.generate(
          "Extract facts worth remembering about the user from this exchange. " +
            "Only extract if genuinely new or correcting existing knowledge. " +
            "Return a JSON array of objects with 'content' (string) and 'category' (string) fields. " +
            "If nothing worth remembering, return [].",
          formatMessagesForPrompt(
            ctx.slidingWindow.slice(-4).map((m) => ({
              role: m.role,
              content: m.content,
            })),
          ),
        );

        let facts: { content: string; category?: string }[] = [];
        try {
          const parsed = JSON.parse(rawFacts);
          if (Array.isArray(parsed)) facts = parsed;
        } catch {
          // malformed JSON — skip memory extraction this turn
        }

        if (facts.length > 0) {
          await Promise.all(
            facts.map(async (f) => {
              const pineconeId = newUuid();
              const { vector } = await this.embeddingService.embed({
                text: f.content,
              });
              const now = newCurrentUTCEpoch();
              await Promise.all([
                this.vectorStore.upsert({
                  id: pineconeId,
                  vector,
                  metadata: {
                    content: f.content,
                    userId: ctx.userId,
                    category: f.category ?? "",
                  },
                }),
                this.userMemoryRepo.create({
                  id: newUuid(),
                  userId: ctx.userId,
                  content: f.content,
                  category: f.category,
                  pineconeId,
                  createdAtEpoch: now,
                  updatedAtEpoch: now,
                  lastAccessedEpoch: now,
                }),
              ]);
            }),
          );
        }
      }

      const intent = await this.textGenerator.generate(
        "Summarize what this conversation is about in one sentence.",
        formatMessagesForPrompt(
          ctx.slidingWindow.slice(-6).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        ),
      );
      await this.conversationRepo.updateIntent(ctx.conversationId, intent);

      const newTokenEstimate =
        ctx.totalTokens +
        Math.ceil(ctx.userMessage.length / 4) +
        Math.ceil(ctx.finalReply.length / 4);
      if (newTokenEstimate > 70_000) {
        await this.conversationRepo.flagForCompression(ctx.conversationId);
      }
    } catch (err) {
      console.error("[assistant] postProcess error:", err);
    }
  }

  private buildOrchestratorHistory(
    messages: Message[],
  ): IOrchestratorMessage[] {
    const resolvedIds = new Set<string>(
      messages
        .filter((m) => m.role === MESSAGE_ROLE.TOOL && m.toolCallId)
        .map((m) => m.toolCallId!),
    );

    // Drop ASSISTANT_TOOL_CALL messages where a call_id has no TOOL response
    // (can happen if a previous request crashed mid-execution)
    const keptToolCallIds = new Set<string>();
    const sanitized = messages.filter((m) => {
      if (m.role !== MESSAGE_ROLE.ASSISTANT_TOOL_CALL || !m.toolCallsJson)
        return true;
      const calls: IToolCall[] = JSON.parse(m.toolCallsJson);
      const complete = calls.every((c) => resolvedIds.has(c.id));
      if (complete) calls.forEach((c) => keptToolCallIds.add(c.id));
      return complete;
    });

    return sanitized
      .filter(
        (m) =>
          m.role !== MESSAGE_ROLE.TOOL || keptToolCallIds.has(m.toolCallId!),
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        toolCallsJson: m.toolCallsJson,
      }));
  }
}
