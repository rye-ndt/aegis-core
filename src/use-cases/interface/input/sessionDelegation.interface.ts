import type { DelegationRecord } from '../output/cache/sessionDelegation.cache';

export type { DelegationRecord };

export interface ISessionDelegationUseCase {
  save(record: DelegationRecord): Promise<void>;
  findByAddress(address: string): Promise<DelegationRecord | null>;
}
