import { IncomingMessage, ServerResponse } from "http";
import {
  IProcessUserRequest,
  IRawData,
  IQueryData,
} from "../../../../use-cases/interface/input/process.interface";
import { readJsonBody } from "./helper";

export class ProcessControllerConcrete {
  constructor(private readonly processUseCase: IProcessUserRequest) {}

  async handleProcess(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readJsonBody<IRawData>(req);

      const result = await this.processUseCase.processAndStore({
        rawData: body.rawData,
        userID: body.userID,
        requestTimestamp: body.requestTimestamp,
        requestID: body.requestID,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  async handleQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody<IQueryData>(req);
      const result = await this.processUseCase.query({
        rawQuery: body.rawQuery,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }
}
