export enum JWT_ALGORITHM {
  HS256 = "HS256",
}

export enum TOKEN_EXPIRY {
  BEARER = "15m",
  REFRESH = "7d",
}

export enum TOKEN_REDIS_KEY_PREFIX {
  BEARER = "bearer_token:",
}
