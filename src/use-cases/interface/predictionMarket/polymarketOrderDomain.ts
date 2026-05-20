// Polymarket CTF Exchange EIP-712 order payload shared between the new
// `advance()` driver (use-case) and the FE mini-app signer. The matching FE
// constants must stay in lockstep — order field order is part of the hash
// pre-image; changing it here without changing it on the FE produces a
// signature that recovers to the wrong address and /response refuses it.
//
// Source-of-truth domain values verified against Polymarket's clob-client
// `@polymarket/order-utils` for Polygon mainnet.

import type { SigningRequestTypedDataDomain } from "../output/cache/signingRequest.cache";

export const POLYMARKET_CTF_EXCHANGE_POLYGON =
  "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;

export const POLYMARKET_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

export function polymarketOrderDomain(chainId: number): SigningRequestTypedDataDomain {
  return {
    name: "Polymarket CTF Exchange",
    version: "1",
    chainId,
    verifyingContract: POLYMARKET_CTF_EXCHANGE_POLYGON,
  };
}

/** Side enum the CTFExchange contract verifies (0=BUY, 1=SELL). */
export const POLY_SIDE = { BUY: 0, SELL: 1 } as const;

/** signatureType=0: EOA / plain ECDSA. The session-key EOA signs directly. */
export const POLY_SIGNATURE_TYPE_EOA = 0 as const;

export interface PolymarketOrderMessageInput {
  /** Maker = signer = the user's session-key EOA on Polygon. */
  makerEoa: `0x${string}`;
  /** Outcome token id (decimal string, fits in uint256). */
  tokenId: string;
  /** Decimal string, USDC raw units (6 decimals). */
  makerAmount: string;
  /** Decimal string, shares (6 decimals). */
  takerAmount: string;
  side: "BUY" | "SELL";
  /** Random uint256 — caller supplies (uuid-derived is fine, BE never reuses). */
  salt: string;
}

// Returns the EIP-712 `message` field with BigInts pre-stringified so the
// record round-trips through JSON serialisation. The /response handler's
// recovery path re-hashes from the same shape — so FE and BE must build it
// identically. All numeric fields are uint256 strings; `side` and
// `signatureType` are uint8.
// ClobAuth EIP-712 schema used by Polymarket's /auth/api-key endpoint. The
// FE signs this and POSTs the signature to receive its (apiKey, secret,
// passphrase) tuple, which it stores client-side. The BE never sees the
// creds; it only verifies signature recovery to mark setup 'authed'.
export const POLYMARKET_CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

export function polymarketClobAuthDomain(chainId: number): SigningRequestTypedDataDomain {
  return { name: "ClobAuthDomain", version: "1", chainId };
}

export const POLYMARKET_CLOB_AUTH_MESSAGE =
  "This message attests that I control the given wallet";

export function buildPolymarketOrderMessage(
  input: PolymarketOrderMessageInput,
): Record<string, string> {
  return {
    salt: input.salt,
    maker: input.makerEoa,
    signer: input.makerEoa,
    // Public taker (anyone can fill). The CTFExchange canonicalises this.
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: input.tokenId,
    makerAmount: input.makerAmount,
    takerAmount: input.takerAmount,
    expiration: "0",
    nonce: "0",
    feeRateBps: "0",
    side: String(POLY_SIDE[input.side]),
    signatureType: String(POLY_SIGNATURE_TYPE_EOA),
  };
}
