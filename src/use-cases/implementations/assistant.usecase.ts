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
import type { ISpeechToText } from "../interface/output/speechToText.interface";
import type {
  ILLMOrchestrator,
  IOrchestratorMessage,
} from "../interface/output/llmOrchestrator.interface";
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
    /**
     * Factory that builds a per-request IToolRegistry keyed to a specific userId.
     * Keeps concrete adapter imports out of this use-case layer.
     */
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
    const now = newCurrentUTCEpoch();
    const conversationId = input.conversationId ?? newUuid();

    // Create a new conversation record if this is the first message
    if (!input.conversationId) {
      const conversation: Conversation = {
        id: conversationId,
        userId: input.userId,
        title: input.message.slice(0, 60),
        status: CONVERSATION_STATUSES.ACTIVE,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      };
      await this.conversationRepo.create(conversation);
    }

    // Persist the user message
    await this.messageRepo.create({
      id: newUuid(),
      conversationId,
      role: MESSAGE_ROLE.USER,
      content: input.message,
      createdAtEpoch: now,
    });

    // Load full history once before the tool loop
    const dbHistory = await this.messageRepo.findByConversationId(conversationId);
    const history: IOrchestratorMessage[] = this.buildOrchestratorHistory(dbHistory);

    // Build system prompt (with personality context)
    const config = await this.jarvisConfigRepo.get();
    const basePrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = await this.buildSystemPrompt(input.userId, basePrompt);

    const maxRounds =
      config?.maxToolRounds ?? parseInt(process.env.MAX_TOOL_ROUNDS ?? String(DEFAULT_MAX_TOOL_ROUNDS));

    const toolRegistry = this.registryFactory(input.userId);
    const availableTools = toolRegistry.getAll().map((t) => t.definition());
    const toolsUsed: string[] = [];

    console.log("[assistant] systemPrompt:", systemPrompt);
    console.log("[assistant] availableTools:", availableTools.map((t) => t.name));
    console.log("[assistant] historyLength:", history.length);

    // Multi-turn agentic tool loop
    for (let round = 0; round < maxRounds; round++) {
      console.log(`[assistant] round ${round}: calling orchestrator`);
      const response = await this.orchestrator.chat({
        systemPrompt,
        conversationHistory: history,
        availableTools,
      });

      console.log(`[assistant] round ${round}: toolCalls=${JSON.stringify(response.toolCalls ?? null)}, hasText=${!!response.text}`);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Final text reply — persist and return
        const reply = response.text ?? "";
        const replyMessageId = newUuid();
        await this.messageRepo.create({
          id: replyMessageId,
          conversationId,
          role: MESSAGE_ROLE.ASSISTANT,
          content: reply,
          createdAtEpoch: newCurrentUTCEpoch(),
        });
        return { conversationId, messageId: replyMessageId, reply, toolsUsed };
      }

      // Store the abstract IToolCall[] — the orchestrator adapter converts to its own wire format on read-back
      const toolCallsJson = JSON.stringify(response.toolCalls);

      // Persist ASSISTANT_TOOL_CALL message
      await this.messageRepo.create({
        id: newUuid(),
        conversationId,
        role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
        content: "",
        toolCallsJson,
        createdAtEpoch: newCurrentUTCEpoch(),
      });

      // Append to in-memory history so the next orchestrator call sees it
      history.push({
        role: MESSAGE_ROLE.ASSISTANT_TOOL_CALL,
        content: "",
        toolCallsJson,
      });

      // Execute each tool call and append results to in-memory history
      for (const call of response.toolCalls) {
        console.log(`[assistant] executing tool: ${call.toolName}`, call.input);
        const tool = toolRegistry.getByName(call.toolName as TOOL_TYPE);
        if (!tool) {
          console.log(`[assistant] tool NOT FOUND in registry: ${call.toolName}`);
          continue;
        }

        const result = await tool.execute(call.input);
        console.log(`[assistant] tool result:`, result);
        toolsUsed.push(call.toolName);

        const toolResultContent = JSON.stringify(result.data ?? result.error);
        await this.messageRepo.create({
          id: newUuid(),
          conversationId,
          role: MESSAGE_ROLE.TOOL,
          content: toolResultContent,
          toolName: call.toolName as TOOL_TYPE,
          toolCallId: call.id,
          createdAtEpoch: newCurrentUTCEpoch(),
        });

        history.push({
          role: MESSAGE_ROLE.TOOL,
          content: toolResultContent,
          toolName: call.toolName,
          toolCallId: call.id,
        });
      }
      // Loop: history now contains tool results; next iteration re-runs the orchestrator
    }

    // Fallback when max tool rounds are exhausted without a final text reply
    const fallbackReply =
      "I've reached the maximum number of tool-use rounds. Please try rephrasing your request.";
    const fallbackId = newUuid();
    await this.messageRepo.create({
      id: fallbackId,
      conversationId,
      role: MESSAGE_ROLE.ASSISTANT,
      content: fallbackReply,
      createdAtEpoch: newCurrentUTCEpoch(),
    });
    return { conversationId, messageId: fallbackId, reply: fallbackReply, toolsUsed };
  }

  async listConversations(input: IListConversationsInput): Promise<Conversation[]> {
    return this.conversationRepo.findByUserId(input.userId);
  }

  async getConversation(input: IGetConversationInput): Promise<Message[]> {
    return this.messageRepo.findByConversationId(input.conversationId);
  }

  private buildOrchestratorHistory(messages: Message[]): IOrchestratorMessage[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      toolCallId: m.toolCallId,
      toolCallsJson: m.toolCallsJson,
    }));
  }

  private async buildSystemPrompt(userId: string, basePrompt: string): Promise<string> {
    const user = await this.userRepo.findById(userId);
    if (!user || (!user.personalities.length && !user.secondaryPersonalities.length)) {
      return basePrompt;
    }

    const parts: string[] = [];
    if (user.personalities.length) {
      parts.push(`primary — ${user.personalities.join(", ")}`);
    }
    if (user.secondaryPersonalities.length) {
      parts.push(`secondary — ${user.secondaryPersonalities.join(", ")}`);
    }

    return `${basePrompt}\n\nPersonality: ${parts.join(". ")}.`;
  }
}
