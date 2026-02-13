import { SUPPORTED_CATEGORIES } from "../../../helpers/enums/supportedFunctions.enum";
import { StandardizedData } from "../input/IStoreData";

export interface IVector {
  id: string;
  vector: number[];
}
//what this system expects the outter service to do
export interface IVectorService {
  process(text: string): Promise<IVector[]>;
}

export interface ICategorizeService {
  process(text: string): Promise<SUPPORTED_CATEGORIES>;
  queryCategoryFromRequest(raw: string): Promise<SUPPORTED_CATEGORIES>;
}

export interface IVectorDB {
  store(data: StandardizedData): Promise<void>;
  retrieve(
    category: SUPPORTED_CATEGORIES,
    queryVectors: IVector[],
  ): Promise<StandardizedData[]>;
}

export interface IChunker {
  process(text: string): Promise<string[]>;
}

export interface IVectorReferenceDB {
  getVectorIDsByCategory(category: SUPPORTED_CATEGORIES): Promise<string[]>;
}
