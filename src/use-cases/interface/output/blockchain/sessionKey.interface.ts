export interface SessionKeyScope {
  maxAmountPerTxUsd: number;
  allowedTokenAddresses: string[];
  expiresAtEpoch: number;
}

export interface ISessionKeyService {
  grant(params: {
    smartAccountAddress: string;
    scope: SessionKeyScope;
  }): Promise<{ sessionKeyAddress: string; txHash: string }>;
  revoke(smartAccountAddress: string, sessionKeyAddress: string): Promise<{ txHash: string }>;
  isValid(smartAccountAddress: string, sessionKeyAddress: string): Promise<boolean>;
}
