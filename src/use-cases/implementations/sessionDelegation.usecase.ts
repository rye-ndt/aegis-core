import type { ISessionDelegationUseCase } from '../interface/input/sessionDelegation.interface';
import type { ISessionDelegationCache, DelegationRecord } from '../interface/output/cache/sessionDelegation.cache';

export class SessionDelegationUseCaseImpl implements ISessionDelegationUseCase {
  constructor(private readonly cache: ISessionDelegationCache) {}

  save(record: DelegationRecord): Promise<void> {
    return this.cache.save(record);
  }

  findByAddress(address: string): Promise<DelegationRecord | null> {
    return this.cache.findByAddress(address);
  }
}
