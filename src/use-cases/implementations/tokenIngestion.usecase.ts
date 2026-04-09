import type { ITokenIngestionUseCase } from "../interface/input/tokenIngestion.interface";
import type { ITokenCrawlerJob } from "../interface/output/tokenCrawler.interface";
import type { ITokenRegistryDB, TokenRecordInit } from "../interface/output/repository/tokenRegistry.repo";
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";

export class TokenIngestionUseCase implements ITokenIngestionUseCase {
  constructor(
    private readonly crawler: ITokenCrawlerJob,
    private readonly tokenRegistryDB: ITokenRegistryDB,
  ) {}

  async ingest(chainId: number): Promise<void> {
    const tokens = await this.crawler.fetchTokens(chainId);
    if (tokens.length === 0) {
      console.log("[TokenIngestionUseCase] no tokens returned, skipping upsert");
      return;
    }
    const now = newCurrentUTCEpoch();
    let upserted = 0;
    for (const token of tokens) {
      const record: TokenRecordInit = {
        id: newUuid(),
        symbol: token.symbol,
        name: token.name,
        chainId: token.chainId,
        address: token.address,
        decimals: token.decimals,
        isNative: token.isNative,
        isVerified: false, // crawler-ingested tokens are never pre-verified
        logoUri: token.logoUri ?? null,
        deployerAddress: token.deployerAddress ?? null,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      };
      try {
        await this.tokenRegistryDB.upsert(record);
        upserted++;
      } catch (err) {
        console.error(`[TokenIngestionUseCase] upsert failed for ${token.symbol}:`, err);
      }
    }
    console.log(`[TokenIngestionUseCase] upserted ${upserted}/${tokens.length} tokens for chainId=${chainId}`);
  }
}
