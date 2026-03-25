export interface IUserProfile {
  userId: string;
  displayName: string | null;
  personalities: string[];
  wakeUpHour: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface UserProfileUpsert {
  userId: string;
  displayName?: string;
  personalities: string[];
  wakeUpHour: number | null;
}

export interface IUserProfileDB {
  upsert(profile: UserProfileUpsert): Promise<void>;
  findByUserId(userId: string): Promise<IUserProfile | null>;
}
