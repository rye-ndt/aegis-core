import { PRIMARY_CATEGORY } from "../../../helpers/enums/categories.enum";
import { TextChunk } from "./chunker.interface";

export interface CategorizedItem {
  chunkId: string;
  category: PRIMARY_CATEGORY;
  tags: string[];
}

export interface ICategorizer {
  process(text: string): Promise<CategorizedItem>;
  batchProcess(chunks: TextChunk[]): Promise<CategorizedItem[]>;
}
