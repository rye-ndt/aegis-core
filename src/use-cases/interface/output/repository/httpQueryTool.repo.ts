export interface IHttpQueryTool {
  id: string;
  userId: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT";
  requestBodySchema: string;
  isActive: boolean;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface IHttpQueryToolHeader {
  id: string;
  toolId: string;
  headerKey: string;
  headerValue: string;
  isEncrypted: boolean;
}

export interface ICreateHttpQueryTool {
  id: string;
  userId: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT";
  requestBodySchema: string;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface ICreateHttpQueryToolHeader {
  id: string;
  toolId: string;
  headerKey: string;
  headerValue: string;
  isEncrypted: boolean;
  createdAtEpoch: number;
}

export interface IHttpQueryToolDB {
  create(tool: ICreateHttpQueryTool): Promise<void>;
  createHeaders(headers: ICreateHttpQueryToolHeader[]): Promise<void>;
  findActiveByUser(userId: string): Promise<IHttpQueryTool[]>;
  findById(id: string): Promise<IHttpQueryTool | null>;
  getHeaders(toolId: string): Promise<IHttpQueryToolHeader[]>;
  deactivate(id: string, userId: string): Promise<void>;
}
