import type { Abi } from "viem";

/**
 * Aster Diamond facet ABI fragments.
 *
 * Phase 1 ships fragments for the read-only surface only:
 *  - PairsManagerFacet.pairsV4(): list known stock/forex/crypto pairs.
 *  - TradingReaderFacet.getMarketInfos(address[]): mark prices.
 *
 * Phase 2 will append:
 *  - TradingReaderFacet.getPositionsV2(address): positions struct (deferred
 *    per fix #11 — the struct must be re-confirmed against verified BscScan
 *    source and an integration test before shipping).
 *  - TradingPortalFacet.openMarketTrade / closeTrade / updateTradeTpAndSl.
 *
 * SOURCE: https://bscscan.com/address/0x1b6F2d3844C6ae7D56ceb3C3643b9060ba28FEb0#code
 *         (Diamond proxy — calls route to per-facet verified implementations)
 *
 * IMPORTANT: when refreshing this file, paste the verified output struct
 * verbatim from BscScan. Hand-translating struct member order has caused
 * silent decode bugs on similar projects.
 */

const PAIR_VIEW_TUPLE = {
  type: "tuple",
  components: [
    { name: "name",        type: "string"  },
    { name: "pairBase",    type: "address" },
    { name: "base",        type: "address" },
    // basePosition empirically decodes as a large uint (not uint16). The
    // safe minimal shape is `uint256` here — the field is unused by Phase 1
    // logic; the registry only reads `name` and `pairBase`.
    { name: "basePosition", type: "uint256" },
    { name: "feedAddress", type: "address" },
    // Sized as uint256 to be tolerant of decode overflow — these slots
    // empirically carry full 32-byte values regardless of solidity declaration.
    { name: "pairType",    type: "uint256" },
    { name: "status",      type: "uint256" },
    { name: "maxLongOiUsd",  type: "uint256" },
    { name: "maxShortOiUsd", type: "uint256" },
    { name: "fundingFeePerBlockP",  type: "uint256" },
    { name: "minFundingFeeR",       type: "uint256" },
    { name: "maxFundingFeeR",       type: "uint256" },
  ],
} as const;

export const ASTER_PAIRS_ABI = [
  {
    name: "pairsV4",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "pairs", ...PAIR_VIEW_TUPLE, type: "tuple[]" }],
  },
  {
    name: "getPairByBaseV4",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "base", type: "address" }],
    outputs: [{ name: "pair", ...PAIR_VIEW_TUPLE }],
  },
] as const satisfies Abi;

// MarketInfo struct shape inferred from the live response payload size:
// 640 bytes for 3 pairs ⇒ 6 fields × 32 bytes per entry. Member names below
// reflect the visible ordering on Aster's reader; if the contract ABI is
// later refreshed against the verified BscScan source, replace the comment.
const MARKET_INFO_TUPLE = {
  type: "tuple",
  components: [
    { name: "pairBase",  type: "address" },
    { name: "longQty",   type: "uint256" },
    { name: "shortQty",  type: "uint256" },
    { name: "lpLongAvgPrice",  type: "uint256" },
    { name: "lpShortAvgPrice", type: "uint256" },
    { name: "markPrice",       type: "uint256" },
  ],
} as const;

// Position struct candidate.
//
// The Diamond's TradingReaderFacet source is NOT verified on BscScan and
// Aster's contracts are explicitly not open-sourced ("core chain contracts
// and RPC infrastructure will not be open-sourced at the moment", Aster
// docs, 2026-05-04). The struct below is a candidate inferred from
// gTrade/GNS-style perpetual readers (the spiritual ancestor) and the
// `OpenDataInput` shape we already use for `openMarketTrade`.
//
// `AsterPositionsProvider.mapRawPosition()` MUST be paired with this struct
// when shipping to production. If the live decode produces nonsense, the
// provider throws and the close/SL/TP capability surfaces a clean failure
// rather than silently returning bad data.
//
// TODO_VERIFY_ABI(positions): replace with the verified output struct as
// soon as we get one (paste-from-source, do not hand-translate). Track in
// `output/aster/status.md`.
const POSITION_TUPLE = {
  type: "tuple",
  components: [
    { name: "tradeHash",     type: "bytes32" },
    { name: "pairBase",      type: "address" },
    { name: "user",          type: "address" },
    { name: "isLong",        type: "bool"    },
    { name: "tokenIn",       type: "address" },
    { name: "marginUsd",     type: "uint256" }, // collateral, in tokenIn decimals
    { name: "qty",           type: "uint256" }, // 1e10 fixed-point
    { name: "entryPrice",    type: "uint256" }, // 1e8 fixed-point
    { name: "stopLoss",      type: "uint256" }, // 1e8 fixed-point, 0 = unset
    { name: "takeProfit",    type: "uint256" }, // 1e8 fixed-point, 0 = unset
    { name: "timestamp",     type: "uint256" }, // unix epoch seconds
    { name: "markPrice",     type: "uint256" }, // 1e8 fixed-point (computed)
    { name: "pnlUsd",        type: "int256"  }, // signed, 1e6 USDC-scale (TODO verify)
    { name: "fundingFeeUsd", type: "uint256" },
    { name: "rolloverFeeUsd", type: "uint256" },
  ],
} as const;

export const ASTER_READER_ABI = [
  {
    name: "getMarketInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "pairBases", type: "address[]" }],
    outputs: [{ name: "markets", ...MARKET_INFO_TUPLE, type: "tuple[]" }],
  },
  {
    name: "getPositionsV2",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ name: "positions", ...POSITION_TUPLE, type: "tuple[]" }],
  },
] as const satisfies Abi;

// TradingPortalFacet — write surface used by the broker provider.
export const ASTER_PORTAL_ABI = [
  {
    name: "openMarketTrade",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{
      name: "data",
      type: "tuple",
      components: [
        { name: "pairBase",   type: "address" },
        { name: "isLong",     type: "bool"    },
        { name: "tokenIn",    type: "address" },
        { name: "amountIn",   type: "uint256" },
        { name: "qty",        type: "uint256" },
        { name: "price",      type: "uint256" },
        { name: "stopLoss",   type: "uint256" },
        { name: "takeProfit", type: "uint256" },
        { name: "broker",     type: "uint256" },
      ],
    }],
    outputs: [{ name: "tradeHash", type: "bytes32" }],
  },
  {
    name: "closeTrade",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeHash", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "updateTradeTpAndSl",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeHash",     type: "bytes32" },
      { name: "stopLoss",      type: "uint256" },
      { name: "takeProfit",    type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;
