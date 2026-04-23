// BE 2: ITokenDelegationDB interface and domain types

export interface TokenDelegation {
  id: string;
  userId: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  limitRaw: string;   // bigint as decimal string
  spentRaw: string;   // bigint as decimal string
  validUntil: number; // unix epoch seconds
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface NewTokenDelegation {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  limitRaw: string;
  validUntil: number;
}

export interface ITokenDelegationDB {
  /** Insert or update delegations for a user. On conflict resets spentRaw to '0'. */
  upsertMany(userId: string, delegations: NewTokenDelegation[]): Promise<void>;

  /** Returns delegations where validUntil > now (unix epoch seconds). */
  findActiveByUserId(userId: string): Promise<TokenDelegation[]>;

  /** BigInt-adds amountRaw to spentRaw for the given (userId, tokenAddress) row. */
  addSpent(userId: string, tokenAddress: string, amountRaw: string): Promise<void>;
}
