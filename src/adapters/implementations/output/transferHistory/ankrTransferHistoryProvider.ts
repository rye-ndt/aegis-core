import { createLogger } from "../../../../helpers/observability/logger";
import {
  getAnkrBlockchain,
  getNativeTokenInfo,
  NATIVE_PSEUDO_ADDRESS,
} from "../../../../helpers/chainConfig";
import { UnsupportedChainError } from "../../../../helpers/errors/unsupportedChainError";
import type {
  ITransferHistoryProvider,
  TransferDirection,
  TransferHistoryPage,
  TransferHistoryQuery,
  TransferRecord,
} from "../../../../use-cases/interface/output/blockchain/transferHistoryProvider.interface";

const log = createLogger("AnkrTransferHistoryProvider");

const ANKR_PUBLIC_ENDPOINT = "https://rpc.ankr.com/multichain";
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_BACKOFFS_MS = [200, 800] as const;

type AnkrTransaction = {
  blockchain: string;
  blockNumber: string | number;
  blockHash?: string;
  hash: string;
  from: string;
  to: string;
  value?: string;
  status?: string;
  timestamp: string | number;
  // Some responses nest decoded transfers; we only consume the top-level
  // value/from/to/hash for the native path here. Token transfers are merged
  // separately from getTokenTransfers.
};

type AnkrTokenTransfer = {
  blockchain: string;
  fromAddress: string;
  toAddress: string;
  contractAddress?: string | null;
  value: string;
  valueRawInteger: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  transactionHash: string;
  blockHeight: string | number;
  timestamp: string | number;
  /** Ankr does not expose logIndex on every row; some payloads use `eventIndex`. */
  eventIndex?: string | number;
  logIndex?: string | number;
};

type RpcEnvelope<T> = {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

type GetTxByAddressResult = {
  transactions: AnkrTransaction[];
  nextPageToken?: string;
};

type GetTokenTransfersResult = {
  transfers: AnkrTokenTransfer[];
  nextPageToken?: string;
};

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function toNumber(v: string | number | undefined, fallback = 0): number {
  if (v == null) return fallback;
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (v.startsWith("0x") || v.startsWith("0X")) {
    const n = Number.parseInt(v, 16);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function deriveDirection(
  address: string,
  from: string,
  to: string,
): TransferDirection {
  const me = address.toLowerCase();
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (f === me && t === me) return "self";
  if (f === me) return "out";
  return "in";
}

function formatAmount(rawIntegerStr: string, decimals: number): string {
  let raw: bigint;
  try {
    raw = BigInt(rawIntegerStr);
  } catch {
    return "0.000000";
  }
  if (decimals <= 0) return `${raw.toString()}.000000`;
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6).padEnd(6, "0");
  return `${whole.toString()}.${fracStr}`;
}

export type AnkrTransferHistoryProviderOpts = {
  apiKey?: string;
};

export class AnkrTransferHistoryProvider implements ITransferHistoryProvider {
  private readonly endpoint: string;

  constructor(opts?: AnkrTransferHistoryProviderOpts) {
    if (opts?.apiKey) {
      this.endpoint = `${ANKR_PUBLIC_ENDPOINT}/${opts.apiKey}`;
    } else {
      this.endpoint = ANKR_PUBLIC_ENDPOINT;
      log.warn({ endpoint: ANKR_PUBLIC_ENDPOINT }, "ankr-api-key-missing");
    }
  }

  async getHistory(q: TransferHistoryQuery): Promise<TransferHistoryPage> {
    const blockchain = getAnkrBlockchain(q.chainId);
    if (!blockchain) {
      throw new UnsupportedChainError(q.chainId);
    }

    const start = Date.now();
    log.debug(
      {
        chainId: q.chainId,
        address: shortAddr(q.address),
        blockchain,
        fromEpoch: q.fromEpoch,
        toEpoch: q.toEpoch,
        limit: q.limit,
      },
      "ankr-history-request",
    );

    const [txPage, tokenPage] = await Promise.all([
      this.fetchTxByAddress(blockchain, q),
      this.fetchTokenTransfers(blockchain, q),
    ]);

    const native = getNativeTokenInfo(q.chainId);
    const items: TransferRecord[] = [];

    for (const t of txPage.transactions) {
      const valueStr = t.value ?? "0";
      let valueRaw: bigint;
      try {
        valueRaw = valueStr.startsWith("0x") ? BigInt(valueStr) : BigInt(valueStr);
      } catch {
        valueRaw = 0n;
      }
      // Skip pure contract calls with no native value movement.
      if (valueRaw === 0n) continue;
      // Skip failed txs; Ankr returns "1"/"0" or "0x1"/"0x0".
      const status = (t.status ?? "1").toString();
      if (status === "0" || status === "0x0") continue;
      const decimals = native?.decimals ?? 18;
      const symbol = native?.symbol ?? "";
      items.push({
        chainId: q.chainId,
        txHash: t.hash as `0x${string}`,
        logIndex: null,
        blockNumber: toNumber(t.blockNumber),
        timestampEpoch: toNumber(t.timestamp),
        direction: deriveDirection(q.address, t.from, t.to),
        from: t.from.toLowerCase() as `0x${string}`,
        to: t.to.toLowerCase() as `0x${string}`,
        tokenAddress: NATIVE_PSEUDO_ADDRESS as `0x${string}`,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        isNative: true,
        amountRaw: valueRaw.toString(),
        amountFormatted: formatAmount(valueRaw.toString(), decimals),
        usdValue: null,
      });
    }

    for (const tr of tokenPage.transfers) {
      const contract = (tr.contractAddress ?? "").toLowerCase();
      if (!contract) continue;
      const decimals = tr.tokenDecimals ?? 18;
      const logIndex = tr.logIndex != null ? toNumber(tr.logIndex) :
                       tr.eventIndex != null ? toNumber(tr.eventIndex) : 0;
      items.push({
        chainId: q.chainId,
        txHash: tr.transactionHash as `0x${string}`,
        logIndex,
        blockNumber: toNumber(tr.blockHeight),
        timestampEpoch: toNumber(tr.timestamp),
        direction: deriveDirection(q.address, tr.fromAddress, tr.toAddress),
        from: tr.fromAddress.toLowerCase() as `0x${string}`,
        to: tr.toAddress.toLowerCase() as `0x${string}`,
        tokenAddress: contract as `0x${string}`,
        tokenSymbol: tr.tokenSymbol ?? "",
        tokenDecimals: decimals,
        isNative: false,
        amountRaw: tr.valueRawInteger,
        amountFormatted: formatAmount(tr.valueRawInteger, decimals),
        usdValue: null,
      });
    }

    // Optional direction filter.
    const filtered = q.direction
      ? items.filter((i) => i.direction === q.direction)
      : items;

    // Sort by (blockNumber desc, logIndex desc).
    filtered.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
      const al = a.logIndex ?? -1;
      const bl = b.logIndex ?? -1;
      return bl - al;
    });

    // Cursor: prefer token transfers cursor (richer source) then tx cursor.
    // The provider treats this as opaque; merging the two cursors is messy, so
    // we surface the union as a JSON-encoded token+tx cursor pair. Callers
    // should pass it back unmodified.
    const nextCursor =
      txPage.nextPageToken || tokenPage.nextPageToken
        ? JSON.stringify({
            tx: txPage.nextPageToken ?? null,
            token: tokenPage.nextPageToken ?? null,
          })
        : null;

    log.info(
      { chainId: q.chainId, count: filtered.length, durationMs: Date.now() - start },
      "history-fetched",
    );

    return { items: filtered, nextCursor };
  }

  private parseCursor(cursor?: string): { tx?: string; token?: string } {
    if (!cursor) return {};
    try {
      const parsed = JSON.parse(cursor) as { tx?: string | null; token?: string | null };
      return {
        tx: parsed.tx ?? undefined,
        token: parsed.token ?? undefined,
      };
    } catch {
      return {};
    }
  }

  private async fetchTxByAddress(
    blockchain: string,
    q: TransferHistoryQuery,
  ): Promise<GetTxByAddressResult> {
    const { tx: pageToken } = this.parseCursor(q.cursor);
    const params: Record<string, unknown> = {
      blockchain: [blockchain],
      address: [q.address],
      pageSize: q.limit,
      descOrder: true,
      includeLogs: false,
    };
    if (q.fromEpoch != null) params.fromTimestamp = q.fromEpoch;
    if (q.toEpoch != null) params.toTimestamp = q.toEpoch;
    if (pageToken) params.pageToken = pageToken;

    const body = await this.rpcCall<GetTxByAddressResult>(
      "ankr_getTransactionsByAddress",
      params,
    );
    return {
      transactions: body.transactions ?? [],
      nextPageToken: body.nextPageToken,
    };
  }

  private async fetchTokenTransfers(
    blockchain: string,
    q: TransferHistoryQuery,
  ): Promise<GetTokenTransfersResult> {
    const { token: pageToken } = this.parseCursor(q.cursor);
    const params: Record<string, unknown> = {
      blockchain: [blockchain],
      address: [q.address],
      pageSize: q.limit,
      descOrder: true,
    };
    if (q.fromEpoch != null) params.fromTimestamp = q.fromEpoch;
    if (q.toEpoch != null) params.toTimestamp = q.toEpoch;
    if (pageToken) params.pageToken = pageToken;

    const body = await this.rpcCall<GetTokenTransfersResult>(
      "ankr_getTokenTransfers",
      params,
    );
    return {
      transfers: body.transfers ?? [],
      nextPageToken: body.nextPageToken,
    };
  }

  private async rpcCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.rpcCallOnce<T>(method, params);
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          const backoffMs = RETRY_BACKOFFS_MS[attempt - 1] ?? 200;
          const status = (err as { status?: number }).status;
          const name = err instanceof Error ? err.name : undefined;
          log.warn({ status, name, attempt, method }, "ankr-history-retry");
          await new Promise<void>((r) => setTimeout(r, backoffMs));
        }
      }
    }
    log.error({ err: lastErr, method }, "ankr-history-failed");
    throw lastErr;
  }

  private async rpcCallOnce<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw Object.assign(new Error(`Ankr HTTP ${resp.status}`), { status: resp.status });
      }
      const env = (await resp.json()) as RpcEnvelope<T>;
      if (env.error) {
        throw new Error(`Ankr RPC error ${env.error.code}: ${env.error.message}`);
      }
      if (env.result === undefined) {
        throw new Error("Ankr RPC: empty result");
      }
      return env.result;
    } finally {
      clearTimeout(timer);
    }
  }
}
