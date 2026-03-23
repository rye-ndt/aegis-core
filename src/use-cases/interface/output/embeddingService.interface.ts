export interface IEmbeddingService {
  embed(input: { text: string }): Promise<{ vector: number[]; tokenCount: number }>;
}
