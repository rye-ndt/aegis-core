export type RequestType = 'auth' | 'sign' | 'approve';
export type ApproveSubtype = 'session_key' | 'aegis_guard';

// ── Request bodies (BE → Redis → FE) ─────────────────────────────────────────

interface BaseRequest {
  requestId: string;
  requestType: RequestType;
  createdAt: number;
  expiresAt: number;
}

export interface AuthRequest extends BaseRequest {
  requestType: 'auth';
  telegramChatId: string;
}

export interface SignRequest extends BaseRequest {
  requestType: 'sign';
  userId: string;
  to: string;
  value: string;
  data: string;
  description: string;
  autoSign: boolean;
}

export interface ApproveRequest extends BaseRequest {
  requestType: 'approve';
  userId: string;
  subtype: ApproveSubtype;
  suggestedTokens?: Array<{ address: string; symbol: string; decimals: number }>;
  reapproval?: boolean;
  tokenAddress?: string;
  amountRaw?: string;
}

export type MiniAppRequest = AuthRequest | SignRequest | ApproveRequest;

// ── Response bodies (FE → BE) ─────────────────────────────────────────────────

interface BaseResponse {
  requestId: string;
  requestType: RequestType;
  privyToken: string;
}

export interface AuthResponse extends BaseResponse {
  requestType: 'auth';
  telegramChatId: string;
}

export interface SignResponse extends BaseResponse {
  requestType: 'sign';
  txHash?: string;
  rejected?: boolean;
}

export interface DelegationRecord {
  publicKey: string;
  address: `0x${string}`;
  smartAccountAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  permissions: unknown[];
  grantedAt: number;
}

export interface AegisGrant {
  sessionKeyAddress: string;
  smartAccountAddress: string;
  tokens: Array<{ address: string; limit: string; validUntil: number }>;
}

export interface ApproveResponse extends BaseResponse {
  requestType: 'approve';
  subtype: ApproveSubtype;
  delegationRecord?: DelegationRecord;
  aegisGrant?: AegisGrant;
  rejected?: boolean;
}

export type MiniAppResponse = AuthResponse | SignResponse | ApproveResponse;
