export interface PendingCollection {
  capabilityId: string;
  state: Record<string, unknown>;
  /** UTC epoch seconds. */
  expiresAt: number;
}

export interface IPendingCollectionStore {
  get(channelId: string): Promise<PendingCollection | null>;
  save(channelId: string, pending: PendingCollection): Promise<void>;
  clear(channelId: string): Promise<void>;
}
