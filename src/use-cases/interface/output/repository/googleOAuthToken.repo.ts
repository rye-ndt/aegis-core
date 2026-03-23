export interface GoogleOAuthToken {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** UTC epoch seconds when the access token expires. */
  expiresAtEpoch: number;
  scope: string;
  updatedAtEpoch: number;
}

export interface IGoogleOAuthTokenDB {
  findByUserId(userId: string): Promise<GoogleOAuthToken | null>;
  upsert(token: GoogleOAuthToken): Promise<void>;
}
