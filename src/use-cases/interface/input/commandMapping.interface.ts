export interface ICommandMappingUseCase {
  /**
   * Create or overwrite the mapping for a command.
   * @param bareCommand  Command without slash, e.g. "buy"
   * @param toolId       Active toolId from tool_manifests
   * @throws UNKNOWN_COMMAND if bareCommand does not correspond to a known INTENT_COMMAND
   * @throws TOOL_NOT_FOUND  if toolId is missing or inactive
   */
  setMapping(bareCommand: string, toolId: string): Promise<{ command: string; toolId: string }>;

  /**
   * Returns the toolId mapped to this command, or null if none.
   * @param bareCommand  "buy" (without slash)
   */
  getMapping(bareCommand: string): Promise<string | null>;

  /** Returns all command → toolId pairs. */
  listMappings(): Promise<Array<{ command: string; toolId: string }>>;

  /**
   * Deletes the mapping for this command.
   * @param bareCommand  "buy" (without slash)
   */
  deleteMapping(bareCommand: string): Promise<void>;
}
