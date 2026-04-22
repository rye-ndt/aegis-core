import type { MiniAppRequest } from '../../../../adapters/implementations/input/http/miniAppRequest.types';

export interface IMiniAppRequestCache {
  store(request: MiniAppRequest): Promise<void>;
  retrieve(requestId: string): Promise<MiniAppRequest | null>;
  delete(requestId: string): Promise<void>;
}
