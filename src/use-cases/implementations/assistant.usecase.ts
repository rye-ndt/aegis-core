import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { CHAIN_CONFIG } from "../../helpers/chainConfig";
import { CONVERSATION_STATUSES } from "../../helpers/enums/statuses.enum";
import { MESSAGE_ROLE } from "../../helpers/enums/messageRole.enum";
import { createLogger } from "../../helpers/observability/logger";
import type {
  IAssistantUseCase,
  IChatInput,
  IChatResponse,
} from "../interface/input/assistant.interface";
import type {
  ILLMOrchestrator,
  IOrchestratorMessage,
  IToolCall,
} from "../interface/output/orchestrator.interface";
import type { IToolRegistry } from "../interface/output/tool.interface";
import type { IConversationDB } from "../interface/output/repository/conversation.repo";
import type {
  IMessageDB,
  Message,
} from "../interface/output/repository/message.repo";

const log = createLogger("assistantUseCase");
const DEFAULT_SYSTEM_PROMPT =
  `You are an AI trading assistant on ${CHAIN_CONFIG.name}. Help users understand DeFi, token prices, and on-chain actions. Be concise and precise.`;
const DEFAULT_MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_ROUNDS = parseInt(
  process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_TOOL_ROUNDS),
  10,
);
const MESSAGE_HISTORY_LIMIT = Number(process.env.MESSAGE_HISTORY_LIMIT ?? 30);

interface IToolResult {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  result: { success: boolean; data?: unknown; error?: unknown };
  latencyMs: number;
}

export class AssistantUseCaseImpl implements IAssistantUseCase {
  constructor(
    private readonly orchestrator: ILLMOrchestrator,
    private readonly registryFactory: (userId: string, conversationId: string) => Promise<IToolRegistry>,
    private readonly conversationRepo: IConversationDB,
    private readonly messageRepo: IMessageDB,
  ) {}

  async chat(input: IChatInput): Promise<IChatResponse> {
    const conversationId = await this.initConversation(input);

    const [allMessages] = await Promise.all([
      this.messageRepo.findByConversationId(conversationId, MESSAGE_HISTORY_LIMIT),
      this.messageRepo.create({
        id: newUuid(),
        conversationId,
        role: MESSAGE_ROLE.USER,
        content: input.message,
        createdAtEpoch: newCurrentUTCEpoch(),
      }),
    ] as const);

    const recentMessages = allMessages.slice(-20);
    const slidingWindow: IOrchestratorMessage[] = [
      ...this.buildOrchestratorHistory(recentMessages),
      {
        role: MESSAGE_ROLE.USER,
        // Datetime in the user turn keeps the system-prompt prefix byte-identical
        // across calls so OpenAI's automatic prompt-prefix cache stays warm.
        content: `[Current datetime: ${new Date().toISOString()}]\n${input.message}`,
        imageBase64Url: input.imageBase64Url,
      },
    ];

    const systemPrompt = DEFAULT_SYSTEM_PROMPT;

    const toolRegistry = await this.registryFactory(input.userId, conversationId);
    const availableTools = toolRegistry.getAll().map((t) => t.definition());
    const toolsUsed: IToolResult[] = [];
    let finalReply = "";

    log.info(
      { step: "history-loaded", count: slidingWindow.length - 1, conversationId, userId: input.userId },
      "chat started",
    );
    log.debug({ choice: "tools-loaded", tools: availableTools.map((t) => t.name) }, "tool registry built");

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const llmStart = Date.now();
      const llmResponse = await this.orchestrator.chat({
        systemPrompt,
        conversationHistory: slidingWindow,
        availableTools,
      });
      const latencyMs = Date.now() - llmStart;
      const toolCallCount = llmResponse.toolCalls?.length ?? 0;
      log.info(
        { step: "llm-response", toolCallCount, latencyMs, promptTokens: llmResponse.usage?.promptTokens ?? "?", completionTokens: llmResponse.usage?.completionTokens ?? "?" },
        `LLM round ${round + 1} complete`,
      );

      if (!llmResponse.toolCalls?.length) {
        finalReply = llmResponse.text ?? "";
        log.debug({ choice: "final-reply", replyLength: finalReply.length }, "no tool calls — final reply");
        break;
      }

      log.debug({ choice: "tool-calls", tools: llmResponse.toolCalls.map((tc) => tc.toolName) }, "executing tools");
      const roundResults = await Promise.all(
        llmResponse.toolCalls.map((tc) => this.executeTool(tc, toolRegistry)),
      );
      for (const r of roundResults) {
        log.info({ step: "tool-result", toolName: r.toolName, success: r.result.success, latencyMs: r.latencyMs }, "tool complete");
      }

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
            toolName: r.toolName,
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

    return {
      conversationId,
      messageId,
      reply: finalReply,
      toolsUsed: toolsUsed.map((t) => t.toolName),
    };
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
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });
    return conversationId;
  }

  private async executeTool(
    call: IToolCall,
    toolRegistry: IToolRegistry,
  ): Promise<IToolResult> {
    const start = Date.now();
    const tool = toolRegistry.getByName(call.toolName);

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

  private buildOrchestratorHistory(messages: Message[]): IOrchestratorMessage[] {
    // createdAtEpoch is second-precision and tool-round messages are persisted
    // in parallel, so rows in the same round tie on timestamp. Apply a stable
    // role-priority tiebreaker so ASSISTANT_TOOL_CALL always precedes its
    // TOOL responses, which precede the following ASSISTANT/USER turn —
    // otherwise OpenAI rejects the request with "tool must follow tool_calls".
    const rolePriority: Record<string, number> = {
      [MESSAGE_ROLE.USER]: 0,
      [MESSAGE_ROLE.ASSISTANT_TOOL_CALL]: 1,
      [MESSAGE_ROLE.TOOL]: 2,
      [MESSAGE_ROLE.ASSISTANT]: 3,
    };
    const ordered = [...messages].sort((a, b) => {
      if (a.createdAtEpoch !== b.createdAtEpoch)
        return a.createdAtEpoch - b.createdAtEpoch;
      return (rolePriority[a.role] ?? 99) - (rolePriority[b.role] ?? 99);
    });

    const resolvedIds = new Set<string>(
      ordered
        .filter((m) => m.role === MESSAGE_ROLE.TOOL && m.toolCallId)
        .map((m) => m.toolCallId!),
    );

    const keptToolCallIds = new Set<string>();
    const sanitized = ordered.filter((m) => {
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
