/**
 * Black-box tests for SendCapability. Stubs every collaborator so we can
 * exercise the multi-turn state machine end-to-end without a database, an
 * LLM, or a bot.
 *
 * Run with: npx tsx --test tests/sendCapability.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SendCapability } from "../src/adapters/implementations/output/capabilities/sendCapability";
import type { SendCapabilityDeps } from "../src/adapters/implementations/output/capabilities/sendCapability";
import { CapabilityDispatcher } from "../src/use-cases/implementations/capabilityDispatcher.usecase";
import { CapabilityRegistry } from "../src/use-cases/implementations/capabilityRegistry";
import { InMemoryPendingCollectionStore } from "../src/adapters/implementations/output/pendingCollectionStore/inMemory";
import type {
  Artifact,
  CapabilityCtx,
} from "../src/use-cases/interface/input/capability.interface";
import type { IArtifactRenderer } from "../src/use-cases/interface/output/artifactRenderer.interface";
import type { IIntentUseCase, ToolManifest, ITokenRecord } from "../src/use-cases/interface/input/intent.interface";
import { INTENT_COMMAND } from "../src/helpers/enums/intentCommand.enum";

class CaptureRenderer implements IArtifactRenderer {
  readonly rendered: Artifact[] = [];
  async render(a: Artifact): Promise<void> { this.rendered.push(a); }
}

const manifest: ToolManifest = {
  toolId: "t1",
  name: "SendTokens",
  protocolName: "Test",
  description: "send",
  chainIds: [1],
  inputSchema: { type: "object", properties: { amountHuman: { type: "string" } }, required: [] },
  finalSchema: undefined,
  requiredFields: undefined,
  steps: [],
} as unknown as ToolManifest;

const token: ITokenRecord = {
  address: "0xtoken",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  chainId: 1,
  isNative: false,
} as ITokenRecord;

function mkDeps(over: Partial<SendCapabilityDeps> = {}): SendCapabilityDeps {
  const intentUseCase: Partial<IIntentUseCase> = {
    selectTool: async () => ({ toolId: "t1", manifest }),
    compileSchema: async () => ({
      params: { amountHuman: "10" },
      tokenSymbols: { from: "USDC" },
      resolverFields: {},
    }) as never,
    searchTokens: async () => [token],
    buildRequestBody: async () => ({ to: "0xto", data: "0xdead", value: "0" }),
    generateMissingParamQuestion: async () => "What amount?",
  };
  return {
    intentUseCase: intentUseCase as IIntentUseCase,
    chainId: 1,
    ...over,
  };
}

test("SendCapability: simple happy path via dispatcher produces confirmation + sign artifact", async () => {
  const cap = new SendCapability(INTENT_COMMAND.SEND, mkDeps());
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, new InMemoryPendingCollectionStore());

  const r = await dispatcher.handle({
    userId: "u1",
    channelId: "c1",
    input: { kind: "text", text: "/send 10 usdc to 0xabc" },
  });
  assert.equal(r.handled, true);
  const kinds = renderer.rendered.map((a) => a.kind);
  // Expected order: confirmation chat, sign_calldata, then noop/terminal.
  assert.ok(kinds.includes("chat"));
  assert.ok(kinds.includes("sign_calldata"));
});

test("SendCapability: selectTool returns null → abort chat artifact", async () => {
  const intentUseCase: Partial<IIntentUseCase> = {
    selectTool: async () => null,
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
    input: { kind: "text", text: "/send something" },
  });
  const art = renderer.rendered[0]!;
  assert.equal(art.kind, "chat");
  if (art.kind === "chat") assert.match(art.text, /No tool is registered/);
});

test("SendCapability: compile missing question → asks user, saves pending state", async () => {
  const intentUseCase: Partial<IIntentUseCase> = {
    selectTool: async () => ({ toolId: "t1", manifest }),
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
    selectTool: async () => ({ toolId: "t1", manifest }),
    compileSchema: async () => ({
      params: { amountHuman: "5" },
      tokenSymbols: { from: "USDC" },
      resolverFields: {},
    }) as never,
    searchTokens: async () => [candA, candB],
    buildRequestBody: async () => ({ to: "0xto", data: "0x", value: "0" }),
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
