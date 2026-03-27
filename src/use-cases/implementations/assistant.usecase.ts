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
import type { IUserDB } from "../interface/output/repository/user.repo";

const DEFAULT_SYSTEM_PROMPT =
  "You are JARVIS, a personal AI assistant. Be concise and helpful.";
const DEFAULT_MAX_TOOL_ROUNDS = 10;

export class AssistantUseCaseImpl implements IAssistantUseCase {
  constructor(
    private readonly speechToText: ISpeechToText,
    private readonly orchestrator: ILLMOrchestrator,
    private readonly registryFactory: (userId: string) => IToolRegistry,
    private readonly conversationRepo: IConversationDB,
    private readonly messageRepo: IMessageDB,
    private readonly jarvisConfigRepo: IJarvisConfigDB,
    private readonly userRepo: IUserDB,
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
    const conversationHistory = await this.loadHistory(conversationId);

    if (input.imageBase64Url) {
      const last = conversationHistory[conversationHistory.length - 1];
      if (last?.role === MESSAGE_ROLE.USER) {
        last.imageBase64Url = input.imageBase64Url;
      }
    }

    const { systemPrompt, maxRounds } = await this.loadChatConfig(input.userId);
    const toolRegistry = this.registryFactory(input.userId);
    const availableTools = toolRegistry.getAll().map((t) => t.definition());
    const toolsUsed: string[] = [];

    console.log("[assistant] systemPrompt:", systemPrompt);
    console.log(
      "[assistant] availableTools:",
      availableTools.map((t) => t.name),
    );
    console.log("[assistant] historyLength:", conversationHistory.length);

    for (let round = 0; round < maxRounds; round++) {
      console.log(`[assistant] round ${round}: calling orchestrator`);

      const response = await this.orchestrator.chat({
        systemPrompt,
        conversationHistory,
        availableTools,
      });

      console.log(
        `[assistant] round ${round}: toolCalls=${JSON.stringify(response.toolCalls ?? null)}, hasText=${!!response.text}`,
      );

      if (!response.toolCalls?.length) {
        return this.persistFinalReply(
          conversationId,
          response.text ?? "",
          toolsUsed,
        );
      }

      await this.persistToolCallBatch(
        conversationId,
        response.toolCalls,
        conversationHistory,
      );

      for (const call of response.toolCalls) {
        await this.executeToolCall(
          call,
          toolRegistry,
          conversationId,
          conversationHistory,
          toolsUsed,
        );
      }
    }

    return this.persistFinalReply(
      conversationId,
      "I've reached the maximum number of tool-use rounds. Please try rephrasing your request.",
      toolsUsed,
    );
  }

  async listConversations(
    input: IListConversationsInput,
  ): Promise<Conversation[]> {
    return this.conversationRepo.findByUserId(input.userId);
  }

  async getConversation(input: IGetConversationInput): Promise<Message[]> {
    return this.messageRepo.findByConversationId(input.conversationId);
  }

  private async initConversation(input: IChatInput): Promise<string> {
    const now = newCurrentUTCEpoch();
    const conversationId = input.conversationId ?? newUuid();

    if (!input.conversationId) {
      await this.conversationRepo.create({
        id: conversationId,
        userId: input.userId,
        title: input.message.slice(0, 60),
        status: CONVERSATION_STATUSES.ACTIVE,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
    }

    await this.messageRepo.create({
      id: newUuid(),
      conversationId,
      role: MESSAGE_ROLE.USER,
      content: input.message,
      createdAtEpoch: now,
    });

    return conversationId;
  }

  private async loadHistory(
    conversationId: string,
  ): Promise<IOrchestratorMessage[]> {
    const messages =
      await this.messageRepo.findByConversationId(conversationId);
    return this.buildOrchestratorHistory(messages);
  }

  private async loadChatConfig(
    userId: string,
  ): Promise<{ systemPrompt: string; maxRounds: number }> {
    const config = await this.jarvisConfigRepo.get();
    const basePrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = await this.buildSystemPrompt(userId, basePrompt);
    const maxRounds =
      config?.maxToolRounds ??
      parseInt(process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_TOOL_ROUNDS));
    return { systemPrompt, maxRounds };
  }

  private async persistFinalReply(
    conversationId: string,
    reply: string,
    toolsUsed: string[],
  ): Promise<IChatResponse> {
    const messageId = newUuid();
    await this.messageRepo.create({
      id: messageId,
      conversationId,
      role: MESSAGE_ROLE.ASSISTANT,
      content: reply,
      createdAtEpoch: newCurrentUTCEpoch(),
    });
    return { conversationId, messageId, reply, toolsUsed };
  }

  private async persistToolCallBatch(
    conversationId: string,
    toolCalls: IToolCall[],
    history: IOrchestratorMessage[],
  ): Promise<void> {
    const toolCallsJson = JSON.stringify(toolCalls);
    await this.messageRepo.create({
      id: newUuid(),
      conversationId,
      role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
      content: "",
      toolCallsJson,
      createdAtEpoch: newCurrentUTCEpoch(),
    });
    history.push({
      role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
      content: "",
      toolCallsJson,
    });
  }

  private async executeToolCall(
    call: IToolCall,
    toolRegistry: IToolRegistry,
    conversationId: string,
    history: IOrchestratorMessage[],
    toolsUsed: string[],
  ): Promise<void> {
    console.log(`[assistant] executing tool: ${call.toolName}`, call.input);

    const tool = toolRegistry.getByName(call.toolName as TOOL_TYPE);
    if (!tool) {
      console.log(`[assistant] tool NOT FOUND in registry: ${call.toolName}`);
      const content = JSON.stringify(
        `Tool "${call.toolName}" is not available.`,
      );
      await this.persistToolResult(conversationId, call, content, history);
      return;
    }

    const result = await tool.execute(call.input);
    console.log(`[assistant] tool result:`, result);
    toolsUsed.push(call.toolName);
    await this.persistToolResult(
      conversationId,
      call,
      JSON.stringify(result.data ?? result.error),
      history,
    );
  }

  private async persistToolResult(
    conversationId: string,
    call: IToolCall,
    content: string,
    history: IOrchestratorMessage[],
  ): Promise<void> {
    await this.messageRepo.create({
      id: newUuid(),
      conversationId,
      role: MESSAGE_ROLE.TOOL,
      content,
      toolName: call.toolName as TOOL_TYPE,
      toolCallId: call.id,
      createdAtEpoch: newCurrentUTCEpoch(),
    });
    history.push({
      role: MESSAGE_ROLE.TOOL,
      content,
      toolName: call.toolName,
      toolCallId: call.id,
    });
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

  private async buildSystemPrompt(
    userId: string,
    basePrompt: string,
  ): Promise<string> {
    const now = new Date();
    const dateContext = `Current date and time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}).`;

    const user = await this.userRepo.findById(userId);
    if (
      !user ||
      (!user.personalities.length && !user.secondaryPersonalities.length)
    ) {
      return `${basePrompt}\n\n${dateContext}`;
    }

    const parts: string[] = [];
    if (user.personalities.length) {
      parts.push(`primary — ${user.personalities.join(", ")}`);
    }
    if (user.secondaryPersonalities.length) {
      parts.push(`secondary — ${user.secondaryPersonalities.join(", ")}`);
    }

    return `${basePrompt}\n\nPersonality: ${parts.join(". ")}.\n\n${dateContext}`;
  }
}
