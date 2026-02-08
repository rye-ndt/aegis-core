import { SUPPORTED_CATEGORIES } from "../../../helpers/enums/supportedFunctions.enum";
import { IVector } from "../output/IVectorize";

// What outer service expects this service to do
export interface StandardizedData {
  id: string;
  rawData: string;
  vector: IVector[];
  category: SUPPORTED_CATEGORIES;
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

export interface IProcessUserRequest {
  processAndStore(data: IRawData): Promise<IStoreResponse>;
  query(query: IQueryData): Promise<IQueryResponse>;
}
