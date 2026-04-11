export type Permission = {
  tokenAddress: string;
  maxAmount: string;
  validUntil: number;
};

export type DelegationRecord = {
  publicKey: string;
  address: string;
  smartAccountAddress: string;
  signerAddress: string;
  permissions: Permission[];
  grantedAt: number;
};

export interface ISessionDelegationCache {
  save(record: DelegationRecord): Promise<void>;
  findByAddress(address: string): Promise<DelegationRecord | null>;
  disconnect(): Promise<void>;
}
