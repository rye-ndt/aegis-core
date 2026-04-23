import type {
  IPendingCollectionStore,
  PendingCollection,
} from "../../../../use-cases/interface/output/pendingCollectionStore.interface";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";

export class InMemoryPendingCollectionStore implements IPendingCollectionStore {
  private readonly map = new Map<string, PendingCollection>();

  async get(channelId: string): Promise<PendingCollection | null> {
    const v = this.map.get(channelId);
    if (!v) return null;
    if (v.expiresAt <= newCurrentUTCEpoch()) {
      this.map.delete(channelId);
      return null;
    }
    return v;
  }

  async save(channelId: string, pending: PendingCollection): Promise<void> {
    this.map.set(channelId, pending);
  }

  async clear(channelId: string): Promise<void> {
    this.map.delete(channelId);
  }
}
