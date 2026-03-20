import { MESSAGE_ROLE } from "../../../helpers/enums/messageRole.enum";
import { IToolDefinition } from "./tool.interface";

export interface IOrchestratorMessage {
  role: MESSAGE_ROLE;
  content: string;
  /** For TOOL role — the name of the tool that produced this result */
  toolName?: string;
  /** Links a tool result back to the original tool call */
  toolCallId?: string;
}

export interface IToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface IOrchestratorResponse {
  /** Final text reply to the user. Present when the LLM produces a direct answer. */
  text?: string;
  /** Tool calls the LLM wants to make. Present when the LLM delegates to tools. */
  toolCalls?: IToolCall[];
}

export interface IOrchestratorInput {
  systemPrompt: string;
  conversationHistory: IOrchestratorMessage[];
  availableTools: IToolDefinition[];
}

export interface ILLMOrchestrator {
  /**
   * Given the conversation history and available tools, returns either a
   * direct text response or a list of tool calls to execute.
   */
  chat(input: IOrchestratorInput): Promise<IOrchestratorResponse>;
}
