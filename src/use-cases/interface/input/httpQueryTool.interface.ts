export interface IRegisterHttpQueryToolInput {
  userId: string;
  name: string;
  description: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT";
  requestBodySchema: Record<string, unknown>;
  headers: Array<{
    key: string;
    value: string;
    encrypt: boolean;
  }>;
}

export interface IListHttpQueryToolsOutput {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: string;
  requestBodySchema: Record<string, unknown>;
  headers: Array<{ key: string; isEncrypted: boolean }>;
  createdAtEpoch: number;
}

export interface IHttpQueryToolUseCase {
  register(input: IRegisterHttpQueryToolInput): Promise<{ id: string; name: string }>;
  list(userId: string): Promise<IListHttpQueryToolsOutput[]>;
  deactivate(id: string, userId: string): Promise<void>;
}
