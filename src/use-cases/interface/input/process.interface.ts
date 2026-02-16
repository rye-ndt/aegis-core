import { PRIMARY_CATEGORY } from "../../../helpers/enums/categories.enum";
import { IVector } from "../shared/IVectorize";

// What outer service expects this service to do
export interface StandardizedData {
  id: string;
  rawData: string;
  vector: IVector[];
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

export interface IProcessUserRequest {
  processAndStore(data: IRawData): Promise<IStoreResponse>;
  query(query: IQueryData): Promise<IQueryResponse>;
}

