import { cosineSimilarity } from "../../../../helpers/consine";
import { newUuid } from "../../../../helpers/uuid";
import {
  IChunker,
  TextChunk,
} from "../../../../use-cases/interface/output/chunker.interface";
import { IVectorizer } from "../../../../use-cases/interface/output/vectorizer.interface";

interface Config {
  ollamaUrl: string;
  model: string;
  similarityThreshold: number;
  maxSentencesPerChunk: number;
  minSentencesPerChunk: number;
}

export interface SemanticChunk {
  text: string;
  sentences: string[];
  sentenceCount: number;
  avgSimilarity: number;
}

export class OllamaChunker implements IChunker {
  constructor(
    private readonly config: Config,
    private readonly embedder: IVectorizer,
  ) {}

  async process(text: string): Promise<TextChunk[]> {
    const sentences = this.splitIntoSentences(text);

    const chunks = await this.semanticChunk(sentences);

    const resp: TextChunk[] = [];

    chunks.forEach((chunk, i) => {
      console.log(
        `--- Chunk ${i + 1} (${chunk.sentenceCount} sentences, avg sim: ${chunk.avgSimilarity}) ---`,
      );
      console.log(chunk.text);
      console.log();

      resp.push({
        id: newUuid(),
        chunkText: chunk.text,
        originalText: text,
      });
    });

    return resp;
  }

  private async semanticChunk(sentences: string[]): Promise<SemanticChunk[]> {
    if (sentences.length === 0) return [];

    if (sentences.length === 1) {
      return [
        {
          text: sentences[0],
          sentences,
          sentenceCount: 1,
          avgSimilarity: 1.0,
        },
      ];
    }

    const embeddedSentences = await this.embedAll(sentences);

    const similarities: number[] = [];

    for (let i = 1; i < sentences.length; i++) {
      similarities.push(
        cosineSimilarity(embeddedSentences[i - 1], embeddedSentences[i]),
      );
    }

    const minSim = Math.min(...similarities).toFixed(3);
    const maxSim = Math.max(...similarities).toFixed(3);
    const avgSim = (
      similarities.reduce((a, b) => a + b, 0) / similarities.length
    ).toFixed(3);

    console.log(
      `[SemanticChunk] Similarity — min: ${minSim}, max: ${maxSim}, avg: ${avgSim}`,
    );

    const chunks: SemanticChunk[] = [];

    let currentSentences: string[] = [sentences[0]];
    let currentSims: number[] = [];

    for (let i = 1; i < sentences.length; i++) {
      const sim = similarities[i - 1];

      const isBoundary = sim < this.config.similarityThreshold;
      const hitSizeCap =
        currentSentences.length >= this.config.maxSentencesPerChunk;
      const aboveMinSize =
        currentSentences.length >= this.config.minSentencesPerChunk;

      if ((isBoundary && aboveMinSize) || hitSizeCap) {
        chunks.push(buildChunk(currentSentences, currentSims));

        currentSentences = [sentences[i]];
        currentSims = [];
      } else {
        currentSentences.push(sentences[i]);
        currentSims.push(sim);
      }
    }

    if (currentSentences.length > 0) {
      chunks.push(buildChunk(currentSentences, currentSims));
    }

    console.log(`[SemanticChunk] ${chunks.length} chunks created\n`);
    return chunks;
  }

  private splitIntoSentences(text: string): string[] {
    const protectedText = text
      .replace(
        /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K)\./g,
        "$1<DOT>",
      )
      .replace(/(\d+)\./g, "$1<DOT>");

    const raw = protectedText.split(/(?<=[.!?])\s+(?=[A-Z"'])/);

    return raw
      .map((s) => s.replace(/<DOT>/g, ".").trim())
      .filter((s) => s.length > 0);
  }

  private async embedAll(sentences: string[]): Promise<number[][]> {
    console.log(`  Embedding ${sentences.length} sentences...`);

    const embeddings: number[][] = [];

    for (let i = 0; i < sentences.length; i++) {
      if (i > 0 && i % 10 === 0) {
        console.log(`  ... ${i}/${sentences.length}`);
      }

      const vector = await this.embedder.process(sentences[i]);
      embeddings.push(vector);
    }

    return embeddings;
  }
}

function buildChunk(sentences: string[], sims: number[]): SemanticChunk {
  const avgSimilarity =
    sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 1.0;

  return {
    text: sentences.join(" "),
    sentences,
    sentenceCount: sentences.length,
    avgSimilarity: parseFloat(avgSimilarity.toFixed(4)),
  };
}

