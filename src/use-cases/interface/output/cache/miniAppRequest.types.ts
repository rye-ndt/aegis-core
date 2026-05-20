import type { IntentResult } from '../../input/resultCard.types';
import type {
  Eip712Purpose,
  SigningRequestKind,
  SigningRequestTypedDataDomain,
} from './signingRequest.cache';

export type RequestType = 'auth' | 'sign' | 'approve' | 'onramp';
export type ApproveSubtype = 'session_key' | 'aegis_guard';
export type SignKind = 'yield_deposit' | 'yield_withdraw';

// Re-exported under their FE-payload names so mini-app code reads naturally.
// The mini-app payload and the BE resolution state describe the same request
// from two angles — keeping a single source of truth for the discriminator
// prevents the two sides drifting.
export type SignPrimitive = SigningRequestKind;
export type { Eip712Purpose };
export type SignTypedDataDomain = SigningRequestTypedDataDomain;

export interface YieldDisplayMeta {
  protocolName: string;
  tokenSymbol: string;
  amountHuman: string;
  expectedApy?: number;
}

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
  kind?: SignKind;
  chainId?: number;
  protocolId?: string;
  tokenAddress?: string;
  displayMeta?: YieldDisplayMeta;
  // Field is `primitive` (not `kind`) because `kind` is already used above
  // for the yield_deposit/yield_withdraw classifier. Absent = 'userop'.
  primitive?: SignPrimitive;
  purpose?: Eip712Purpose;
  domain?: SignTypedDataDomain;
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  // BigInts must be pre-stringified — JSON serialisation can't carry them.
  message?: Record<string, unknown>;
  betId?: string;
  positionId?: string;
  /**
   * Plain-English preview the mini-app renders inside its existing approve
   * modal in place of raw to/value/calldata. Always `status: "preview"`. When
   * absent, the mini-app falls back to the legacy raw view (backward compat).
   * Threaded from `Artifact.sign_calldata.preview` → renderer/capability →
   * miniAppRequestCache → `GET /request/:id` → FE.
   */
  preview?: IntentResult;
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

export interface OnrampRequest extends BaseRequest {
  requestType: 'onramp';
  userId: string;
  /** Human-readable USDC amount the user asked to buy. */
  amount: number;
  /** Asset symbol — currently always "USDC". */
  asset: string;
  /** Target chain for the onramp, from CHAIN_CONFIG. */
  chainId: number;
  /** Smart-account address that will receive the funds. */
  walletAddress: string;
}

export type MiniAppRequest = AuthRequest | SignRequest | ApproveRequest | OnrampRequest;

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
  // Stable classification produced by the FE's `interpretSignError`. The BE
  // branches on this to drive recovery flows (insufficient_token_balance →
  // /buy nudge). New codes must be added in lockstep on both sides.
  errorCode?: string;
  errorMessage?: string;
  // Raw underlying error text (viem revert reason, etc.) the FE sends purely
  // for BE diagnostic logs. Never persisted, never re-displayed to the user.
  errorRaw?: string;
  signature?: string;
  signer?: string;
  polymarketOrderId?: string;
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
