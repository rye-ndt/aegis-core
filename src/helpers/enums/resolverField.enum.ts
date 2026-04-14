/**
 * Every key that may appear in a tool manifest's requiredFields schema.
 * Each key has a dedicated resolver function in ResolverEngine (Part 2).
 */
export enum RESOLVER_FIELD {
  FROM_TOKEN_SYMBOL  = "fromTokenSymbol",
  TO_TOKEN_SYMBOL    = "toTokenSymbol",
  READABLE_AMOUNT    = "readableAmount",
  USER_HANDLE        = "userHandle",
}
