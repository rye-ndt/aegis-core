export interface IToolIndexService {
  /**
   * Embeds the tool text and upserts it into the vector store.
   * Uses the DB record `id` (UUID) as the vector id.
   */
  index(params: {
    id: string;
    toolId: string;
    text: string;
    category: string;
    chainIds: number[];
  }): Promise<void>;

  /**
   * Embeds `query` and returns semantically similar tools ordered by score desc.
   * Post-filters by chainId when provided. Drops results below minScore (default 0.3).
   */
  search(
    query: string,
    options: { topK: number; chainId?: number; minScore?: number },
  ): Promise<{ toolId: string; score: number }[]>;

  /** Removes the vector. `id` is the DB record UUID used during index(). */
  delete(id: string): Promise<void>;
}
