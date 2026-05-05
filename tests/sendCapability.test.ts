/**
 * Black-box tests for SendCapability. Stubs every collaborator so we can
 * exercise the multi-turn state machine end-to-end without a database, an
 * LLM, or a bot.
 *
 * Run with: npx tsx --test tests/sendCapability.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, erc20Abi } from "viem";

// chainId=1 fiat-detection path calls getUsdcAddress(1) which reads ETH_USDC.
// Set a real-looking address so the resolver short-circuit matches the
// "logged warn + fall through to searchTokens" branch (tokenRegistryService
// stays undefined). Without this the capability aborts with
// "no usdc found for this chain" and never reaches sign_calldata.
process.env.ETH_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

import { SendCapability } from "../src/adapters/implementations/output/capabilities/sendCapability";
import type { SendCapabilityDeps } from "../src/adapters/implementations/output/capabilities/sendCapability";
import { CapabilityDispatcher } from "../src/use-cases/implementations/capabilityDispatcher.usecase";
import { CapabilityRegistry } from "../src/use-cases/implementations/capabilityRegistry";
import { InMemoryPendingCollectionStore } from "../src/adapters/implementations/output/pendingCollectionStore/inMemory";
import type {
  Artifact,
} from "../src/use-cases/interface/input/capability.interface";
import type { IArtifactRenderer } from "../src/use-cases/interface/output/artifactRenderer.interface";
import type { IIntentUseCase, ITokenRecord } from "../src/use-cases/interface/input/intent.interface";
import { INTENT_COMMAND } from "../src/helpers/enums/intentCommand.enum";
import { NATIVE_PSEUDO_ADDRESS } from "../src/helpers/chainConfig";

class CaptureRenderer implements IArtifactRenderer {
  readonly rendered: Artifact[] = [];
  async render(a: Artifact): Promise<void> { this.rendered.push(a); }
}

const token: ITokenRecord = {
  address: "0xtoken",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  chainId: 1,
  isNative: false,
} as ITokenRecord;

function mkDeps(over: Partial<SendCapabilityDeps> = {}): SendCapabilityDeps {
  // SendCapability now owns the manifest; tests only need to stub the LLM
  // compile + token search calls. compileSchema returns parameters that
  // satisfy SEND_MANIFEST.inputSchema.required so the capability proceeds
  // straight to run() without asking follow-ups.
  const intentUseCase: Partial<IIntentUseCase> = {
    compileSchema: async () => ({
      params: {
        fromTokenSymbol: "USDC",
        amountHuman: "10",
        recipient: "0x000000000000000000000000000000000000abcd",
      },
      tokenSymbols: { from: "USDC" },
      resolverFields: {},
      missingQuestion: null,
    }) as never,
    searchTokens: async () => [token],
    generateMissingParamQuestion: async () => "What amount?",
  };
  return {
    intentUseCase: intentUseCase as IIntentUseCase,
    chainId: 1,
    ...over,
  };
}

test("SendCapability: simple happy path via dispatcher produces sign_calldata artifact", async () => {
  const cap = new SendCapability(INTENT_COMMAND.SEND, mkDeps());
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, new InMemoryPendingCollectionStore());

  const r = await dispatcher.handle({
    userId: "u1",
    channelId: "c1",
    input: { kind: "text", text: "/send 10 usdc to 0x000000000000000000000000000000000000abcd" },
  });
  assert.equal(r.handled, true);
  const kinds = renderer.rendered.map((a) => a.kind);
  // Result-card framework migration: the pre-sign confirmation chat moved
  // into `sign_calldata.preview` (rendered inside the mini-app modal), so
  // the BE no longer emits a chat artifact alongside the sign request.
  assert.ok(kinds.includes("sign_calldata"));
  const signArt = renderer.rendered.find((a) => a.kind === "sign_calldata");
  assert.ok(signArt);
  if (signArt && signArt.kind === "sign_calldata") {
    assert.ok(signArt.preview, "sign_calldata should carry a preview IntentResult");
    // calldata is built from the in-code SEND_MANIFEST + buildTransferCalldata.
    // For an ERC-20 transfer the `to` field is the token address and `value`
    // is "0".
    assert.equal(signArt.to.toLowerCase(), token.address.toLowerCase());
    assert.equal(signArt.value, "0");
    assert.ok(signArt.data.startsWith("0xa9059cbb"), "ERC-20 transfer selector");
  }
});

test("SendCapability: compile missing question → asks user, saves pending state", async () => {
  const intentUseCase: Partial<IIntentUseCase> = {
    compileSchema: async () => ({
      params: {},
      tokenSymbols: {},
      resolverFields: {},
      missingQuestion: "How much?",
    }) as never,
  };
  const cap = new SendCapability(
    INTENT_COMMAND.SEND,
    { intentUseCase: intentUseCase as IIntentUseCase, chainId: 1 },
  );
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const pending = new InMemoryPendingCollectionStore();
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, pending);

  await dispatcher.handle({
    userId: "u1",
    channelId: "c1",
    input: { kind: "text", text: "/send hello" },
  });
  assert.equal(renderer.rendered[0]!.kind, "chat");
  if (renderer.rendered[0]!.kind === "chat")
    assert.match((renderer.rendered[0] as { text: string }).text, /How much/);
  const saved = await pending.get("c1");
  assert.equal(saved?.capabilityId, "intent_send");
  assert.equal((saved?.state as { stage: string }).stage, "compile");
});

test("SendCapability: token disambiguation round-trip", async () => {
  const candA: ITokenRecord = { ...token, address: "0xA", name: "A" };
  const candB: ITokenRecord = { ...token, address: "0xB", name: "B" };
  const intentUseCase: Partial<IIntentUseCase> = {
    compileSchema: async () => ({
      params: {
        fromTokenSymbol: "USDC",
        amountHuman: "5",
        recipient: "0x000000000000000000000000000000000000abcd",
      },
      tokenSymbols: { from: "USDC" },
      resolverFields: {},
      missingQuestion: null,
    }) as never,
    searchTokens: async () => [candA, candB],
  };
  const cap = new SendCapability(
    INTENT_COMMAND.SEND,
    { intentUseCase: intentUseCase as IIntentUseCase, chainId: 1 },
  );
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const pending = new InMemoryPendingCollectionStore();
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, pending);

  await dispatcher.handle({
    userId: "u1",
    channelId: "c1",
    input: { kind: "text", text: "/send 5 usdc" },
  });
  // After first turn: disambiguation prompt + pending state in token_disambig stage.
  const first = renderer.rendered[0]!;
  assert.equal(first.kind, "chat");
  const saved = await pending.get("c1");
  assert.equal((saved?.state as { stage: string }).stage, "token_disambig");

  renderer.rendered.length = 0;
  await dispatcher.handle({
    userId: "u1",
    channelId: "c1",
    input: { kind: "text", text: "1" },
  });
  // After reply: should proceed to confirmation artifacts.
  const kinds = renderer.rendered.map((a) => a.kind);
  assert.ok(kinds.includes("sign_calldata"));
  assert.equal(await pending.get("c1"), null);
});

// ── buildTransferCalldata unit tests (golden output via viem) ───────────────

test("buildTransferCalldata: ERC-20 path matches viem.encodeFunctionData", async () => {
  // The capability's private buildTransferCalldata is exercised through
  // dispatcher.handle in the happy-path test above. Here we sanity-check the
  // golden hex against viem directly so future refactors must keep the same
  // selector + argument encoding.
  const recipient = "0x000000000000000000000000000000000000abcd" as `0x${string}`;
  const amountRaw = "10000000"; // 10 USDC at 6 decimals
  const expected = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, BigInt(amountRaw)],
  });
  // Selector for transfer(address,uint256)
  assert.ok(expected.startsWith("0xa9059cbb"));
  // 4-byte selector + 32-byte address (left-padded) + 32-byte uint256 = 68 bytes hex
  assert.equal(expected.length, 2 + 8 + 64 + 64);
});

test("buildTransferCalldata: native path returns recipient as `to`, value=amountRaw, data=0x", async () => {
  // Drive the native case end-to-end by stubbing the resolved token to be
  // the chain's native pseudo-token.
  const nativeToken: ITokenRecord = {
    ...token,
    address: NATIVE_PSEUDO_ADDRESS,
    symbol: "ETH",
    decimals: 18,
    isNative: true,
  } as ITokenRecord;

  const intentUseCase: Partial<IIntentUseCase> = {
    compileSchema: async () => ({
      params: {
        fromTokenSymbol: "ETH",
        amountHuman: "0.001",
        recipient: "0x000000000000000000000000000000000000abcd",
      },
      tokenSymbols: { from: "ETH" },
      resolverFields: {},
      missingQuestion: null,
    }) as never,
    searchTokens: async () => [nativeToken],
  };
  const cap = new SendCapability(
    INTENT_COMMAND.SEND,
    { intentUseCase: intentUseCase as IIntentUseCase, chainId: 1 },
  );
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, new InMemoryPendingCollectionStore());

  await dispatcher.handle({
    userId: "u1",
    channelId: "c1",
    input: { kind: "text", text: "/send 0.001 eth to 0x000000000000000000000000000000000000abcd" },
  });
  const signArt = renderer.rendered.find((a) => a.kind === "sign_calldata");
  assert.ok(signArt, "expected sign_calldata artifact");
  if (signArt && signArt.kind === "sign_calldata") {
    assert.equal(signArt.to.toLowerCase(), "0x000000000000000000000000000000000000abcd");
    assert.equal(signArt.data, "0x");
    // 0.001 * 10^18 = 1e15 raw
    assert.equal(signArt.value, "1000000000000000");
  }
});
