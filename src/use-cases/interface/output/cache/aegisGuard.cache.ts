export interface AegisGuardTokenDelegation {
  tokenAddress: string;   // checksummed ERC20 address
  tokenSymbol: string;
  tokenDecimals: number;
  limitWei: string;       // bigint serialised as decimal string
  validUntil: number;     // unix epoch seconds
}

export interface AegisGuardGrant {
  sessionKeyAddress: string;
  smartAccountAddress: string;
  delegations: AegisGuardTokenDelegation[];
  grantedAt: number;
}

export interface IAegisGuardCache {
  saveGrant(userId: string, grant: AegisGuardGrant, ttlSeconds: number): Promise<void>;
  getGrant(userId: string): Promise<AegisGuardGrant | null>;

  addSpent(userId: string, tokenAddress: string, amountWei: string, ttlSeconds: number): Promise<string>;
  getSpent(userId: string, tokenAddress: string): Promise<string>;
}
