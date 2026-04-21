import type { PrivyUserProfile } from "../privyAuth.interface";

export interface IUserProfileCache {
  store(userId: string, profile: PrivyUserProfile, ttlSeconds: number): Promise<void>;
  get(userId: string): Promise<PrivyUserProfile | null>;
}
