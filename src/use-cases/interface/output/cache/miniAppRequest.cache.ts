import type { MiniAppRequest } from './miniAppRequest.types';

export interface IMiniAppRequestCache {
  store(request: MiniAppRequest): Promise<void>;
  retrieve(requestId: string): Promise<MiniAppRequest | null>;
  delete(requestId: string): Promise<void>;
}
