export interface IUserPreference {
  id: string;
  userId: string;
  aegisGuardEnabled: boolean;
  updatedAtEpoch: number;
}

export interface IUserPreferencesDB {
  upsert(userId: string, patch: { aegisGuardEnabled: boolean }): Promise<void>;
  findByUserId(userId: string): Promise<IUserPreference | null>;
}
