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

export class AssistantUseCaseImpl implements IAssistantUseCase {
  constructor(
    private readonly speechToText: ISpeechToText,
    private readonly orchestrator: ILLMOrchestrator,
    private readonly toolRegistry: IToolRegistry,
    private readonly conversationRepo: IConversationDB,
    private readonly messageRepo: IMessageDB,
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

    await this.messageRepo.create({
      id: newUuid(),
      conversationId,
      role: MESSAGE_ROLE.USER,
      content: input.message,
      createdAtEpoch: now,
    });

    const history = await this.messageRepo.findByConversationId(conversationId);
    const orchestratorHistory: IOrchestratorMessage[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      toolCallId: m.toolCallId,
    }));

    const tools = this.toolRegistry.getAll();
    const response = await this.orchestrator.chat({
      systemPrompt:
        "You are JARVIS, a personal AI assistant. Be concise and helpful.",
      conversationHistory: orchestratorHistory,
      availableTools: tools.map((t) => t.definition()),
    });

    const toolsUsed: string[] = [];

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        const tool = this.toolRegistry.getByName(call.toolName as TOOL_TYPE);
        if (!tool) continue;

        const result = await tool.execute(call.input);
        toolsUsed.push(call.toolName);

        await this.messageRepo.create({
          id: newUuid(),
          conversationId,
          role: MESSAGE_ROLE.TOOL,
          content: JSON.stringify(result.data ?? result.error),
          toolName: call.toolName as TOOL_TYPE,
          toolCallId: call.id,
          createdAtEpoch: newCurrentUTCEpoch(),
        });
      }

      // Re-run orchestrator with tool results to generate final text reply
      // TODO: implement multi-turn tool loop
    }

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

  async listConversations(
    input: IListConversationsInput,
  ): Promise<Conversation[]> {
    return this.conversationRepo.findByUserId(input.userId);
  }

  async getConversation(input: IGetConversationInput): Promise<Message[]> {
    return this.messageRepo.findByConversationId(input.conversationId);
  }
}
