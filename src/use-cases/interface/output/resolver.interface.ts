import type { ITokenRecord } from "./repository/tokenRegistry.repo";

/** Thrown when a token query returns >1 candidate; handler enters disambiguation sub-loop. */
export class DisambiguationRequiredError extends Error {
  constructor(
    public readonly slot: "from" | "to",
    public readonly symbol: string,
    public readonly candidates: ITokenRecord[],
  ) {
    super(
      `Disambiguation required for ${slot} token "${symbol}" — ${candidates.length} candidates`,
    );
    this.name = "DisambiguationRequiredError";
  }
}

/** The fully resolved payload after all resolver functions have run. */
export interface ResolvedPayload {
  /** Resolved from-token (address, decimals, symbol). Null if not present in requiredFields. */
  fromToken: ITokenRecord | null;
  /** Resolved to-token. */
  toToken: ITokenRecord | null;
  /** Raw amount in wei as a string ("1000000"). Null if not applicable. */
  rawAmount: string | null;
  /** EVM wallet address of the recipient resolved from userHandle. Null if not present. */
  recipientAddress: string | null;
  /** Telegram user ID of the recipient (stored for post-confirm notification). Null if N/A. */
  recipientTelegramUserId: string | null;
  /** Current user's SCA / EOA address, injected from session. */
  senderAddress: string | null;
}

export interface IResolverEngine {
  /**
   * Run all resolver functions for the given set of human-provided field values.
   *
   * @param resolverFields - Raw human values extracted by the LLM (from CompileResult.resolverFields).
   * @param userId         - Internal userId; used to fetch senderAddress from the user profile.
   * @param chainId        - Chain to search tokens on.
   *
   * @throws DisambiguationRequiredError when a token symbol matches multiple candidates.
   */
  resolve(params: {
    resolverFields: Partial<Record<string, string>>;
    userId: string;
    chainId: number;
  }): Promise<ResolvedPayload>;

  /**
   * Look up a single token record by its exact on-chain address.
   * Used by the disambiguation confirm path (Part 3) to confirm a specific candidate.
   */
  resolveTokenByAddress(
    address: string,
    chainId: number,
  ): Promise<ITokenRecord | null>;
}
