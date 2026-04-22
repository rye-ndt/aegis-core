// BE 3: Drizzle implementation of ITokenDelegationDB

import { and, eq, gt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { newUuid } from '../../../../../helpers/uuid';
import { newCurrentUTCEpoch } from '../../../../../helpers/time/dateTime';
import type {
  ITokenDelegationDB,
  NewTokenDelegation,
  TokenDelegation,
} from '../../../../../use-cases/interface/output/repository/tokenDelegation.repo';
import { tokenDelegations } from '../schema';

type Row = typeof tokenDelegations.$inferSelect;

export class DrizzleTokenDelegationRepo implements ITokenDelegationDB {
  constructor(private readonly db: NodePgDatabase) {}

  // ── upsertMany ─────────────────────────────────────────────────────────────
  // On conflict (userId, tokenAddress): update limitRaw, reset spentRaw → '0',
  // refresh validUntil and updatedAtEpoch.

  async upsertMany(userId: string, delegations: NewTokenDelegation[]): Promise<void> {
    if (delegations.length === 0) return;
    const now = newCurrentUTCEpoch();
    const rows = delegations.map((d) => ({
      id: newUuid(),
      userId,
      tokenAddress: d.tokenAddress.toLowerCase(),
      tokenSymbol: d.tokenSymbol,
      tokenDecimals: d.tokenDecimals,
      limitRaw: d.limitRaw,
      spentRaw: '0',
      validUntil: d.validUntil,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    }));

    await this.db
      .insert(tokenDelegations)
      .values(rows)
      .onConflictDoUpdate({
        target: [tokenDelegations.userId, tokenDelegations.tokenAddress],
        set: {
          limitRaw: sql`excluded.limit_raw`,
          spentRaw: '0',
          validUntil: sql`excluded.valid_until`,
          updatedAtEpoch: sql`excluded.updated_at_epoch`,
        },
      });
  }

  // ── findActiveByUserId ──────────────────────────────────────────────────────
  // Returns rows where validUntil > current unix epoch seconds.

  async findActiveByUserId(userId: string): Promise<TokenDelegation[]> {
    const now = newCurrentUTCEpoch();
    const rows = await this.db
      .select()
      .from(tokenDelegations)
      .where(and(eq(tokenDelegations.userId, userId), gt(tokenDelegations.validUntil, now)));
    return rows.map(this.toModel);
  }

  // ── addSpent ───────────────────────────────────────────────────────────────
  // Fetch current row, BigInt-add amountRaw, write back.
  // Single-row updates are serialised by Postgres at the row level — safe enough
  // for the sequential bot traffic pattern.

  async addSpent(userId: string, tokenAddress: string, amountRaw: string): Promise<void> {
    const normalised = tokenAddress.toLowerCase();
    const rows = await this.db
      .select()
      .from(tokenDelegations)
      .where(
        and(
          eq(tokenDelegations.userId, userId),
          eq(tokenDelegations.tokenAddress, normalised),
        ),
      )
      .limit(1);

    if (!rows[0]) return; // no delegation found — nothing to track

    const current = BigInt(rows[0].spentRaw);
    const next = (current + BigInt(amountRaw)).toString();
    const now = newCurrentUTCEpoch();

    await this.db
      .update(tokenDelegations)
      .set({ spentRaw: next, updatedAtEpoch: now })
      .where(eq(tokenDelegations.id, rows[0].id));
  }

  // ── findByUserIdAndToken ────────────────────────────────────────────────────

  async findByUserIdAndToken(userId: string, tokenAddress: string): Promise<TokenDelegation | null> {
    const normalised = tokenAddress.toLowerCase();
    const rows = await this.db
      .select()
      .from(tokenDelegations)
      .where(
        and(
          eq(tokenDelegations.userId, userId),
          eq(tokenDelegations.tokenAddress, normalised),
        ),
      )
      .limit(1);

    return rows[0] ? this.toModel(rows[0]) : null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private toModel(row: Row): TokenDelegation {
    return {
      id: row.id,
      userId: row.userId,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      tokenDecimals: row.tokenDecimals,
      limitRaw: row.limitRaw,
      spentRaw: row.spentRaw,
      validUntil: row.validUntil,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
