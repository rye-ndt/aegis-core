export enum MESSAGE_ROLE {
  USER = "user",
  ASSISTANT = "assistant",
  SYSTEM = "system",
  TOOL = "tool",
  /** Assistant message that contains only tool-call intent (no text). Required to round-trip OpenAI tool_calls through the DB. */
  ASSISTANT_TOOL_CALL = "assistant_tool_call",
}
