export interface ITextGenerator {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}
