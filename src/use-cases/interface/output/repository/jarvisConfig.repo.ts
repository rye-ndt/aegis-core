export interface JarvisConfig {
  systemPrompt: string;
}

export interface IJarvisConfigDB {
  get(): Promise<JarvisConfig | null>;
  update(systemPrompt: string): Promise<void>;
}
