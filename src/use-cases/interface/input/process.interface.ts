import { PRIMARY_CATEGORY } from "../../../helpers/enums/categories.enum";
import { IVectorWithMetadata } from "../output/vectorDB.interface";

// What outer service expects this service to do
export interface StandardizedData {
  id: string;
  rawData: string;
  vector: IVectorWithMetadata[];
  category: PRIMARY_CATEGORY;
  payload?: any;
  createdAtTimestamp: number;
  updatedAtTimestamp: number;
}

export interface IRawData {
  rawData: string;
  userID: string;
  requestTimestamp: number;
  requestID: string;
}

export interface IStoreResponse {
  id: string;
}

export interface IQueryData {
  rawQuery: string;
}

export interface IQueryResponse {
  rawData: string[];
  referenceVectorIDs: string[];
}

export interface IProcessNoteUseCase {
  processAndStore(data: IRawData): Promise<IStoreResponse>;
  query(query: IQueryData): Promise<IQueryResponse>;
}
