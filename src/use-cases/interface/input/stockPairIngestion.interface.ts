export interface IStockPairIngestionUseCase {
  ingest(chainId: number): Promise<void>;
}
