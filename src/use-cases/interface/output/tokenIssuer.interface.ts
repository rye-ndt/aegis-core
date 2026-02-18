export interface TokenPair {
  bearerToken: string;
  refreshToken: string;
}

export enum TokenType {
  BEARER = "bearer",
  REFRESH = "refresh",
}

export interface VerifiedPayload {
  userId: string;
  type: TokenType;
}

export interface ITokenIssuer {
  issue(userId: string): Promise<TokenPair>;
  verify(token: string): Promise<VerifiedPayload>;
  isValid(token: string, type: TokenType): Promise<boolean>;
  revoke(token: string): Promise<void>;
}
