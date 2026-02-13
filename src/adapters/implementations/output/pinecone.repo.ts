import { Pinecone } from "@pinecone-database/pinecone";
import { SUPPORTED_CATEGORIES } from "../../../helpers/enums/supportedFunctions.enum";
import { StandardizedData } from "../../../use-cases/interface/input/IStoreData";
import {
  IVector,
  IVectorDB,
} from "../../../use-cases/interface/output/IVectorize";

type PineconeMetadata = {
  id: string;
  rawData: string;
  category: SUPPORTED_CATEGORIES;
  payload?: any;
  createdAtTimestamp: number;
  updatedAtTimestamp: number;
};

const pinecone = new Pinecone();
const pineconeIndexHost = process.env.PINECONE_INDEX_HOST;

if (!pineconeIndexHost) {
  throw new Error("PINECONE_INDEX_HOST environment variable is not set.");
}

const index = pinecone.index<PineconeMetadata>({ host: pineconeIndexHost });

export class PineconeRepoConcrete implements IVectorDB {
  async store(data: StandardizedData): Promise<void> {
    if (!data.vector || data.vector.length === 0) {
      return;
    }

    const records = data.vector.map((v: IVector) => ({
      id: `${data.id}:${v.id}`,
      values: v.vector,
      metadata: {
        id: data.id,
        rawData: data.rawData,
        category: data.category,
        payload: data.payload,
        createdAtTimestamp: data.createdAtTimestamp,
        updatedAtTimestamp: data.updatedAtTimestamp,
      },
    }));

    await index.upsert({ records });
  }

  async retrieve(
    category: SUPPORTED_CATEGORIES,
    queryVectors: IVector[],
  ): Promise<StandardizedData[]> {
    if (!queryVectors || queryVectors.length === 0) {
      return [];
    }

    const queryVector = queryVectors[0].vector;

    const queryResponse = await index.query({
      vector: queryVector,
      topK: 10,
      includeMetadata: true,
      filter: {
        category,
      },
    });

    const matches = queryResponse.matches ?? [];

    const results: StandardizedData[] = matches
      .map((match) => match.metadata)
      .filter((metadata): metadata is PineconeMetadata => !!metadata)
      .map((metadata) => ({
        id: metadata.id,
        rawData: metadata.rawData,
        vector: [],
        category: metadata.category,
        payload: metadata.payload,
        createdAtTimestamp: metadata.createdAtTimestamp,
        updatedAtTimestamp: metadata.updatedAtTimestamp,
      }));

    return results;
  }
}
