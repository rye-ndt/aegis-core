export interface TextChunk {
  id: string;
  chunkText: string;
  originalText: string;
}

export interface IChunker {
  process(text: string): Promise<TextChunk[]>;
}

