/**
 * Black-box tests for the capability pipeline:
 *   dispatcher + registry + pending store + BuyCapability.
 *
 * Run with: npx tsx --test tests/capability.dispatcher.test.ts
 *
 * These tests DO NOT touch Telegram, Redis, Privy, or any real adapter.
 * They exercise the pure input→output contract of the dispatch layer so
 * that future refactors of handler.ts can't silently regress it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/use-cases/implementations/capabilityRegistry";
import { CapabilityDispatcher } from "../src/use-cases/implementations/capabilityDispatcher.usecase";
import { InMemoryPendingCollectionStore } from "../src/adapters/implementations/output/pendingCollectionStore/inMemory";
import { BuyCapability } from "../src/adapters/implementations/output/capabilities/buyCapability";
import type {
  Artifact,
  Capability,
  CapabilityCtx,
  CollectResult,
} from "../src/use-cases/interface/input/capability.interface";
import type { IArtifactRenderer } from "../src/use-cases/interface/output/artifactRenderer.interface";
import type { IUserProfileDB } from "../src/use-cases/interface/output/repository/userProfile.repo";
import { INTENT_COMMAND } from "../src/helpers/enums/intentCommand.enum";

class CaptureRenderer implements IArtifactRenderer {
  readonly rendered: Artifact[] = [];
  async render(artifact: Artifact, _ctx: CapabilityCtx): Promise<void> {
    this.rendered.push(artifact);
  }
}

const fakeUserProfileRepo = (smartAccountAddress?: string): IUserProfileDB =>
  ({
    findByUserId: async () => (smartAccountAddress ? ({ smartAccountAddress } as never) : null),
  } as unknown as IUserProfileDB);

function mkDispatcher(capabilities: Capability[]) {
  const registry = new CapabilityRegistry();
  for (const c of capabilities) registry.register(c);
  const pending = new InMemoryPendingCollectionStore();
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, pending);
  return { dispatcher, renderer, pending, registry };
}

const baseCtx = (overrides: Partial<Omit<CapabilityCtx, "emit">> = {}) => ({
  userId: "u1",
  channelId: "c1",
  input: { kind: "text" as const, text: "/buy" },
  ...overrides,
});

test("registry: command lookup returns the registered capability", () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const r = new CapabilityRegistry();
  r.register(cap);
  const matched = r.match({ kind: "text", text: "/buy 50" });
  assert.equal(matched?.id, "buy");
});

test("registry: unrelated text returns null", () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const r = new CapabilityRegistry();
  r.register(cap);
  assert.equal(r.match({ kind: "text", text: "hello world" }), null);
});

test("registry: callback prefix match (longest first)", () => {
  const r = new CapabilityRegistry();
  const makeCap = (id: string, prefix: string): Capability => ({
    id,
    triggers: { callbackPrefix: prefix },
    collect: async () => ({ kind: "ok" as const, params: {} }),
    run: async () => ({ kind: "noop" as const }),
  });
  r.register(makeCap("short", "buy"));
  r.register(makeCap("long", "buy_vip"));
  assert.equal(r.match({ kind: "callback", data: "buy_vip:x" })?.id, "long");
  assert.equal(r.match({ kind: "callback", data: "buy:x" })?.id, "short");
});

test("registry: command-collision throws", () => {
  const r = new CapabilityRegistry();
  r.register(new BuyCapability(fakeUserProfileRepo("0xabc"), 1));
  assert.throws(() => r.register(new BuyCapability(fakeUserProfileRepo("0xabc"), 1)));
});

test("dispatcher: no match → handled=false, nothing rendered", async () => {
  const { dispatcher, renderer } = mkDispatcher([]);
  const r = await dispatcher.handle(baseCtx({ input: { kind: "text", text: "hello" } }));
  assert.equal(r.handled, false);
  assert.equal(renderer.rendered.length, 0);
});

test("dispatcher: BuyCapability /buy 50 → asks yes/no, pending saved", async () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const { dispatcher, renderer, pending } = mkDispatcher([cap]);
  const r = await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/buy 50" } }));
  assert.equal(r.handled, true);
  assert.equal(renderer.rendered.length, 1);
  const art = renderer.rendered[0]!;
  assert.equal(art.kind, "chat");
  const saved = await pending.get("c1");
  assert.equal(saved?.capabilityId, "buy");
  assert.equal((saved?.state as { stage: string }).stage, "awaiting_choice");
});

test("dispatcher: /buy with no amount → asks for amount", async () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const { dispatcher, renderer, pending } = mkDispatcher([cap]);
  const r = await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/buy" } }));
  assert.equal(r.handled, true);
  const saved = await pending.get("c1");
  assert.equal((saved?.state as { stage: string }).stage, "awaiting_amount");
  assert.equal(renderer.rendered[0]!.kind, "chat");
});

test("dispatcher: bare number after /buy prompt resumes flow", async () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const { dispatcher, renderer, pending } = mkDispatcher([cap]);
  await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/buy" } }));
  const r = await dispatcher.handle(baseCtx({ input: { kind: "text", text: "25" } }));
  assert.equal(r.handled, true);
  const saved = await pending.get("c1");
  assert.equal((saved?.state as { stage: string; amount: number }).stage, "awaiting_choice");
  assert.equal((saved?.state as { amount: number }).amount, 25);
  assert.equal(renderer.rendered.length, 2);
});

test("dispatcher: callback buy:y:50 produces mini-app-or-chat artifact and clears pending", async () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const { dispatcher, renderer, pending } = mkDispatcher([cap]);
  // Prime with the ask
  await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/buy 50" } }));
  renderer.rendered.length = 0;
  const r = await dispatcher.handle(baseCtx({ input: { kind: "callback", data: "buy:y:50" } }));
  assert.equal(r.handled, true);
  assert.equal(await pending.get("c1"), null);
  const art = renderer.rendered[0]!;
  // deposit path → chat with copy-address button
  assert.equal(art.kind, "chat");
});

test("dispatcher: callback buy:n:50 yields mini_app artifact", async () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const { dispatcher, renderer } = mkDispatcher([cap]);
  await dispatcher.handle(baseCtx({ input: { kind: "callback", data: "buy:n:50" } }));
  assert.equal(renderer.rendered.length, 1);
  assert.equal(renderer.rendered[0]!.kind, "mini_app");
});

test("dispatcher: buy:copy callback returns chat artifact with address", async () => {
  const cap = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const { dispatcher, renderer } = mkDispatcher([cap]);
  await dispatcher.handle(baseCtx({ input: { kind: "callback", data: "buy:copy:0xdeadbeef" } }));
  const art = renderer.rendered[0]!;
  assert.equal(art.kind, "chat");
  if (art.kind === "chat") assert.match(art.text, /0xdeadbeef/);
});

test("dispatcher: fresh command cancels a stale pending flow", async () => {
  const buy = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  // A second capability under a fake command so we can force a different match.
  const other: Capability = {
    id: "ping",
    triggers: { command: INTENT_COMMAND.SEND },
    collect: async () => ({ kind: "ok" as const, params: {} }),
    run: async () => ({ kind: "chat" as const, text: "pong" }),
  };
  const { dispatcher, pending } = mkDispatcher([buy, other]);
  await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/buy" } }));
  assert.notEqual(await pending.get("c1"), null);
  const r = await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/send hi" } }));
  assert.equal(r.handled, true);
  // After the fresh command ran to completion (no ask), pending cleared.
  assert.equal(await pending.get("c1"), null);
});

test("dispatcher: pending collection without match resumes the prior capability", async () => {
  let gotResuming: Record<string, unknown> | undefined = undefined;
  const cap: Capability<{ n: number }> = {
    id: "counter",
    triggers: { command: INTENT_COMMAND.SEND },
    async collect(ctx, resuming): Promise<CollectResult<{ n: number }>> {
      gotResuming = resuming;
      if (ctx.input.kind === "text" && ctx.input.text === "/send") {
        return { kind: "ask", question: "more?", state: { n: 1 } };
      }
      return { kind: "ok", params: { n: (resuming?.n as number) ?? 0 } };
    },
    async run(params): Promise<Artifact> {
      return { kind: "chat", text: `n=${params.n}` };
    },
  };
  const { dispatcher, renderer } = mkDispatcher([cap]);
  await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/send" } }));
  renderer.rendered.length = 0;
  await dispatcher.handle(baseCtx({ input: { kind: "text", text: "go" } }));
  assert.deepEqual(gotResuming, { n: 1 });
  assert.equal((renderer.rendered[0] as { kind: string; text?: string }).text, "n=1");
});

test("registry: default capability handles free text with no command match", () => {
  const r = new CapabilityRegistry();
  const defaultCap: Capability = {
    id: "assistant_chat",
    triggers: {},
    collect: async () => ({ kind: "ok", params: {} }),
    run: async () => ({ kind: "chat", text: "hi" }),
  };
  r.registerDefault(defaultCap);
  assert.equal(r.match({ kind: "text", text: "hello world" })?.id, "assistant_chat");
  // Callbacks never route to default.
  assert.equal(r.match({ kind: "callback", data: "anything" }), null);
});

test("registry: registerDefault twice throws", () => {
  const r = new CapabilityRegistry();
  const cap: Capability = {
    id: "a",
    triggers: {},
    collect: async () => ({ kind: "ok", params: {} }),
    run: async () => ({ kind: "noop" }),
  };
  r.registerDefault(cap);
  const cap2: Capability = { ...cap, id: "b" };
  assert.throws(() => r.registerDefault(cap2));
});

test("dispatcher: command capability beats default on free-text slash commands", async () => {
  const buy = new BuyCapability(fakeUserProfileRepo("0xabc"), 1);
  const defaultCap: Capability = {
    id: "assistant_chat",
    triggers: {},
    collect: async () => ({ kind: "ok", params: {} }),
    run: async () => ({ kind: "chat", text: "SHOULD NOT FIRE" }),
  };
  const registry = new CapabilityRegistry();
  registry.register(buy);
  registry.registerDefault(defaultCap);
  const pending = new InMemoryPendingCollectionStore();
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, pending);

  await dispatcher.handle(baseCtx({ input: { kind: "text", text: "/buy 50" } }));
  assert.equal(renderer.rendered[0]!.kind, "chat");
  const art = renderer.rendered[0]!;
  if (art.kind === "chat") assert.notEqual(art.text, "SHOULD NOT FIRE");
});

test("dispatcher: free text without a slash-command falls through to default", async () => {
  const defaultCap: Capability = {
    id: "assistant_chat",
    triggers: {},
    collect: async () => ({ kind: "ok", params: {} }),
    run: async () => ({ kind: "chat", text: "default reply" }),
  };
  const registry = new CapabilityRegistry();
  registry.registerDefault(defaultCap);
  const pending = new InMemoryPendingCollectionStore();
  const renderer = new CaptureRenderer();
  const dispatcher = new CapabilityDispatcher(registry, renderer, pending);
  const r = await dispatcher.handle(baseCtx({ input: { kind: "text", text: "hello there" } }));
  assert.equal(r.handled, true);
  const art = renderer.rendered[0]!;
  if (art.kind === "chat") assert.equal(art.text, "default reply");
});

test("pendingStore: expired entry is treated as absent", async () => {
  const store = new InMemoryPendingCollectionStore();
  await store.save("c", { capabilityId: "x", state: {}, expiresAt: 0 });
  assert.equal(await store.get("c"), null);
});
