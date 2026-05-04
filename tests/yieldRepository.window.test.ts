/**
 * Unit test for `listSnapshotsBetween` window semantics — `[from, to)`.
 * Run with: npx tsx --test tests/yieldRepository.window.test.ts
 *
 * The repo talks to drizzle/pg, so we exercise the contract through a
 * fake in-memory IYieldRepository that mirrors the real semantics. The
 * real DrizzleYieldRepository delegates the same range condition to SQL
 * (`>= from AND < to`), so this test pins the expected boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  IYieldRepository,
  YieldPositionSnapshot,
} from "../src/use-cases/interface/yield/IYieldRepository";

class FakeYieldRepo implements IYieldRepository {
  private rows: YieldPositionSnapshot[] = [];

  async listSnapshots(userId: string, sinceEpoch: number): Promise<YieldPositionSnapshot[]> {
    return this.rows.filter((r) => r.userId === userId && r.snapshotAtEpoch > sinceEpoch);
  }

  async listSnapshotsBetween(
    userId: string,
    fromEpochInclusive: number,
    toEpochExclusive: number,
  ): Promise<YieldPositionSnapshot[]> {
    return this.rows.filter(
      (r) =>
        r.userId === userId &&
        r.snapshotAtEpoch >= fromEpochInclusive &&
        r.snapshotAtEpoch < toEpochExclusive,
    );
  }

  async upsertSnapshot(snapshot: Omit<YieldPositionSnapshot, "id">): Promise<void> {
    this.rows.push({ ...snapshot, id: String(this.rows.length + 1) });
  }

  async listUsersWithRecentSnapshots(sinceEpoch: number): Promise<string[]> {
    return Array.from(
      new Set(this.rows.filter((r) => r.snapshotAtEpoch > sinceEpoch).map((r) => r.userId)),
    );
  }
}

test("listSnapshotsBetween returns rows in [from, to) — today is excluded", async () => {
  const repo = new FakeYieldRepo();
  const yesterdayStart = Math.floor(new Date("2026-05-03T00:00:00Z").getTime() / 1000);
  const todayStart = Math.floor(new Date("2026-05-04T00:00:00Z").getTime() / 1000);

  // yesterday 23:59:59 — included
  await repo.upsertSnapshot({
    userId: "u1",
    chainId: 43114,
    protocolId: "AAVE_V3",
    tokenAddress: "0xusdc",
    snapshotDateUtc: "2026-05-03",
    balanceRaw: "1",
    principalRaw: "1",
    snapshotAtEpoch: todayStart - 1,
  });
  // today 00:00:01 — excluded
  await repo.upsertSnapshot({
    userId: "u1",
    chainId: 43114,
    protocolId: "AAVE_V3",
    tokenAddress: "0xusdc",
    snapshotDateUtc: "2026-05-04",
    balanceRaw: "2",
    principalRaw: "2",
    snapshotAtEpoch: todayStart + 1,
  });

  const window = await repo.listSnapshotsBetween("u1", yesterdayStart, todayStart);
  assert.equal(window.length, 1);
  assert.equal(window[0]!.snapshotDateUtc, "2026-05-03");
});

test("listSnapshotsBetween includes the from boundary", async () => {
  const repo = new FakeYieldRepo();
  const from = 1_000_000;
  const to = 2_000_000;
  await repo.upsertSnapshot({
    userId: "u1",
    chainId: 1,
    protocolId: "AAVE_V3",
    tokenAddress: "0x",
    snapshotDateUtc: "2026-05-03",
    balanceRaw: "0",
    principalRaw: "0",
    snapshotAtEpoch: from,
  });
  const rows = await repo.listSnapshotsBetween("u1", from, to);
  assert.equal(rows.length, 1);
});
