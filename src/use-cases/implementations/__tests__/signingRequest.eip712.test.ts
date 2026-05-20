/**
 * Run with:
 *   npx tsx --test src/use-cases/implementations/__tests__/signingRequest.eip712.test.ts
 *
 * Slice A acceptance for the zero-sign Polymarket bet rewrite
 * (be/constructions/2026-05-15-zero-sign-bet-be.md, task 4): the /response
 * EIP-712 path must verify that a recovered signer matches the row's
 * `expectedSigner`, refuse mismatches, and require a `polymarketOrderId`
 * on `purpose: 'polymarket_order'`. No real EOA needed — we generate one
 * in-test via viem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { signTypedData } from "viem/accounts";

import { SigningRequestUseCaseImpl } from "../signingRequest.usecase";
import type {
  ISigningRequestCache,
  SigningRequestRecord,
} from "../../interface/output/cache/signingRequest.cache";

// In-memory cache fake — only the methods the use-case touches.
function makeCache(seed?: SigningRequestRecord): ISigningRequestCache & {
  records: Map<string, SigningRequestRecord>;
} {
  const records = new Map<string, SigningRequestRecord>();
  if (seed) records.set(seed.id, seed);
  return {
    records,
    async save(r) {
      records.set(r.id, r);
    },
    async findById(id) {
      return records.get(id) ?? null;
    },
    async resolve(id, status, txHash, errorCode, errorMessage, signature, polymarketOrderId) {
      const r = records.get(id);
      if (!r) return;
      records.set(id, {
        ...r,
        status,
        txHash,
        errorCode,
        errorMessage,
        signature: signature ?? r.signature,
        polymarketOrderId: polymarketOrderId ?? r.polymarketOrderId,
      });
    },
    async cancelPendingForUser() {
      return [];
    },
  };
}

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "amount", type: "uint256" },
  ],
} as const;

const DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "1",
  chainId: 137,
  verifyingContract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
} as const;

function makeOrderRow(id: string, userId: string, expectedSigner: string): SigningRequestRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    userId,
    chatId: 0,
    to: "",
    value: "0",
    data: "0x",
    description: "test order",
    status: "pending",
    createdAt: now,
    expiresAt: now + 600,
    kind: "eip712",
    purpose: "polymarket_order",
    domain: DOMAIN,
    types: ORDER_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    primaryType: "Order",
    message: {
      salt: "1",
      maker: expectedSigner,
      tokenId: "42",
      amount: "1000000",
    },
    expectedSigner,
    betId: "bet-1",
  };
}

test("eip712 polymarket_order: valid signature + orderId resolves to approved", async () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const row = makeOrderRow("req-1", "user-1", account.address);
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  const signature = await signTypedData({
    privateKey: pk,
    domain: DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: 1n,
      maker: account.address,
      tokenId: 42n,
      amount: 1000000n,
    },
  });

  await uc.resolveRequest({
    requestId: "req-1",
    userId: "user-1",
    signature,
    signer: account.address,
    polymarketOrderId: "pm-order-abc",
  });

  const stored = cache.records.get("req-1")!;
  assert.equal(stored.status, "approved");
  assert.equal(stored.signature, signature);
  assert.equal(stored.polymarketOrderId, "pm-order-abc");
});

test("eip712: wrong signer (mismatched recovery) is refused", async () => {
  const pk = generatePrivateKey();
  const wrongPk = generatePrivateKey();
  const expectedAcct = privateKeyToAccount(pk);
  const row = makeOrderRow("req-2", "user-1", expectedAcct.address);
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  // Sign with the WRONG key — recovered address won't match expectedSigner.
  const signature = await signTypedData({
    privateKey: wrongPk,
    domain: DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: 1n,
      maker: expectedAcct.address,
      tokenId: 42n,
      amount: 1000000n,
    },
  });

  await assert.rejects(
    () =>
      uc.resolveRequest({
        requestId: "req-2",
        userId: "user-1",
        signature,
        signer: expectedAcct.address,
        polymarketOrderId: "pm-order-abc",
      }),
    /SIGNING_REQUEST_SIGNER_MISMATCH/,
  );
  assert.equal(cache.records.get("req-2")!.status, "pending");
});

test("eip712 polymarket_order: missing polymarketOrderId is refused", async () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const row = makeOrderRow("req-3", "user-1", account.address);
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  const signature = await signTypedData({
    privateKey: pk,
    domain: DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: 1n,
      maker: account.address,
      tokenId: 42n,
      amount: 1000000n,
    },
  });

  await assert.rejects(
    () =>
      uc.resolveRequest({
        requestId: "req-3",
        userId: "user-1",
        signature,
        signer: account.address,
      }),
    /SIGNING_REQUEST_MISSING_POLYMARKET_ORDER_ID/,
  );
});

test("eip712 clob_auth: signature recovery sufficient, no orderId required", async () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const now = Math.floor(Date.now() / 1000);
  const CLOB_AUTH_TYPES = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  } as const;
  const row: SigningRequestRecord = {
    id: "req-4",
    userId: "user-1",
    chatId: 0,
    to: "",
    value: "0",
    data: "0x",
    description: "clob auth",
    status: "pending",
    createdAt: now,
    expiresAt: now + 600,
    kind: "eip712",
    purpose: "clob_auth",
    domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    types: CLOB_AUTH_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    primaryType: "ClobAuth",
    message: {
      address: account.address,
      timestamp: String(now),
      nonce: "0",
      message: "This message attests that I control the given wallet",
    },
    expectedSigner: account.address,
  };
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  const signature = await signTypedData({
    privateKey: pk,
    domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address: account.address,
      timestamp: String(now),
      nonce: 0n,
      message: "This message attests that I control the given wallet",
    },
  });

  await uc.resolveRequest({
    requestId: "req-4",
    userId: "user-1",
    signature,
    signer: account.address,
  });

  const stored = cache.records.get("req-4")!;
  assert.equal(stored.status, "approved");
  assert.equal(stored.signature, signature);
});

test("eip712: missing signature is refused", async () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const row = makeOrderRow("req-5", "user-1", account.address);
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  await assert.rejects(
    () =>
      uc.resolveRequest({
        requestId: "req-5",
        userId: "user-1",
        polymarketOrderId: "pm-x",
      }),
    /SIGNING_REQUEST_BAD_SIGNATURE/,
  );
});

test("eoa_tx: missing txHash on non-rejected response is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const row: SigningRequestRecord = {
    id: "req-6",
    userId: "user-1",
    chatId: 0,
    to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    value: "0",
    data: "0xa9059cbb",
    description: "sweep",
    status: "pending",
    createdAt: now,
    expiresAt: now + 600,
    kind: "eoa_tx",
  };
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  await assert.rejects(
    () => uc.resolveRequest({ requestId: "req-6", userId: "user-1" }),
    /SIGNING_REQUEST_BAD_TXHASH/,
  );
});

test("userop (default kind): legacy back-compat — no txHash validation, still flips to approved", async () => {
  // Pre-existing rows have no `kind` field; the use-case must treat them
  // as 'userop' and apply the legacy no-validation behaviour.
  const now = Math.floor(Date.now() / 1000);
  const row: SigningRequestRecord = {
    id: "req-7",
    userId: "user-1",
    chatId: 0,
    to: "0x0000000000000000000000000000000000000000",
    value: "0",
    data: "0x",
    description: "legacy",
    status: "pending",
    createdAt: now,
    expiresAt: now + 600,
    // No `kind` — defaults to userop in the use-case.
  };
  const cache = makeCache(row);
  const uc = new SigningRequestUseCaseImpl(cache, () => {});

  await uc.resolveRequest({
    requestId: "req-7",
    userId: "user-1",
    txHash: "0x" + "a".repeat(64),
  });
  assert.equal(cache.records.get("req-7")!.status, "approved");
});
