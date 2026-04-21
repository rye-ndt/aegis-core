import type { ITool } from "./tool.interface";

export interface ISystemToolProvider {
  /**
   * Returns all system tools instantiated for the given user+conversation.
   * Called once per registryFactory invocation.
   */
  getTools(userId: string, conversationId: string): ITool[];
}
