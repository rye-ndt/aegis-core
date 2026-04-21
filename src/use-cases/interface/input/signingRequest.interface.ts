export interface ISigningRequestUseCase {
  createRequest(params: {
    userId: string;
    chatId: number;
    to: string;
    value: string;
    data: string;
    description: string;
  }): Promise<{ requestId: string; pushed: boolean }>;

  resolveRequest(params: {
    requestId: string;
    userId: string;
    txHash?: string;
    rejected?: boolean;
  }): Promise<void>;

  getPendingForUser(userId: string): Promise<{
    requestId: string;
    to: string;
    value: string;
    data: string;
    description: string;
    expiresAt: number;
  } | null>;

  getRequest(requestId: string, userId: string): Promise<{
    requestId: string;
    to: string;
    value: string;
    data: string;
    description: string;
    expiresAt: number;
    status: string;
  } | null>;
}
