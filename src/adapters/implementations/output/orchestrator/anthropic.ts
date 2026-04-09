import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolUseBlock,
  TextBlock,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { MESSAGE_ROLE } from "../../../../helpers/enums/messageRole.enum";
import type {
  ILLMOrchestrator,
  IOrchestratorInput,
  IOrchestratorResponse,
  IToolCall,
} from "../../../../use-cases/interface/output/orchestrator.interface";

export class AnthropicOrchestrator implements ILLMOrchestrator {
  private readonly client: Anthropic;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(input: IOrchestratorInput): Promise<IOrchestratorResponse> {
    const messages: MessageParam[] = input.conversationHistory.map((msg): MessageParam => {
      if (msg.role === MESSAGE_ROLE.ASSISTANT_TOOL_CALL && msg.toolCallsJson) {
        const toolCalls: IToolCall[] = JSON.parse(msg.toolCallsJson);
        return {
          role: "assistant",
          content: toolCalls.map((tc) => ({
            type: "tool_use" as const,
            id: tc.id,
            name: tc.toolName,
            input: tc.input,
          })),
        };
      }

      if (msg.role === MESSAGE_ROLE.TOOL) {
        return {
          role: "user",
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: msg.toolCallId!,
              content: msg.content,
            },
          ],
        };
      }

      if (msg.role === MESSAGE_ROLE.USER && msg.imageBase64Url) {
        const match = msg.imageBase64Url.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          return {
            role: "user",
            content: [
              { type: "text" as const, text: msg.content || "What's in this image?" },
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: match[2],
                },
              },
            ],
          };
        }
      }

      return {
        role: msg.role === MESSAGE_ROLE.USER ? "user" : "assistant",
        content: msg.content,
      };
    });

    const tools: Tool[] = input.availableTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Tool["input_schema"],
    }));

    const response = await this.client.messages.create({
      model: this.model,
      system: input.systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens: 4096,
    });

    const usage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    };

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      const toolCalls: IToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id,
        toolName: b.name,
        input: b.input as Record<string, unknown>,
      }));
      return { toolCalls, usage };
    }

    const textBlock = response.content.find((b): b is TextBlock => b.type === "text");
    return { text: textBlock?.text ?? "", usage };
  }
}
