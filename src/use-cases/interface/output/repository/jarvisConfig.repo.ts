export interface JarvisConfig {
  systemPrompt: string;
  /** Maximum tool-use rounds per chat() call. Falls back to MAX_TOOL_ROUNDS env var (default 10) when absent. */
  maxToolRounds?: number;
}

export interface IJarvisConfigDB {
  get(): Promise<JarvisConfig | null>;
  update(systemPrompt: string): Promise<void>;
}
