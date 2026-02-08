import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import {
  IProcessUserRequest,
  IQueryData,
  IQueryResponse,
  IRawData,
  IStoreResponse,
  StandardizedData,
} from "../interface/input/IStoreData";
import {
  ICategorizeService,
  IVectorDB,
  IVectorService,
} from "../interface/output/IVectorize";
import { IError } from "../interface/input/IError";

//defines what user can do to interact with the system
export class ProcessUserRequest implements IProcessUserRequest {
  private vectorizer: IVectorService;
  private categorizer: ICategorizeService;
  private vectorDB: IVectorDB;

  //user can store, retrieve and request for aggregation / compilation
  constructor(
    vectorizer: IVectorService,
    categorizer: ICategorizeService,
    vectorDB: IVectorDB
  ) {
    this.vectorizer = vectorizer;
    this.categorizer = categorizer;
    this.vectorDB = vectorDB;
  }

  async processAndStore(data: IRawData): Promise<IStoreResponse> {
    try {
      //vectorize
      const vectors = await this.vectorizer.process(data.rawData);

      //categorize
      const category = await this.categorizer.process(data.rawData);

      //store the data
      const storeData: StandardizedData = {
        id: newUuid(),
        rawData: data.rawData,
        vector: vectors,
        category: category,
        createdAtTimestamp: newCurrentUTCEpoch(),
        updatedAtTimestamp: newCurrentUTCEpoch(),
      };

      await this.vectorDB.store(storeData);

      return {
        id: storeData.id,
      };
    } catch (err) {
      if (err instanceof IError) {
        throw err;
      }

      throw new IError(
        "An unknown error occurred while processing and storing data."
      );
    }
  }

  async query(query: IQueryData): Promise<IQueryResponse> {
    try {
      //categorize the query
      const category = await this.categorizer.queryCategoryFromRequest(
        query.rawQuery
      );

      //query and response
      const queryResponse = await this.vectorDB.retrieve(
        category,
        query.rawQuery
      );

      return {
        rawData: queryResponse.map((data) => data.rawData),
        referenceVectorIDs: queryResponse.map((data) => data.id),
      };

      //query and response
    } catch (err) {
      if (err instanceof IError) {
        throw err;
      }

      throw new IError("An unknown error occurred while querying the data.");
    }
  }
}
