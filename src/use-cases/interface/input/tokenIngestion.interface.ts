export interface ITokenIngestionUseCase {
  /**
   * Fetch tokens for the given chainId from all configured sources
   * and upsert them into the registry.
   */
  ingest(chainId: number): Promise<void>;
}
