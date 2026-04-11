import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { v4 as uuidv4 } from 'uuid';
import type {
  IPendingDelegation,
  IPendingDelegationDB,
} from '../../../../../use-cases/interface/output/repository/pendingDelegation.repo';
import { type ZerodevMessage, resolveExpiresAtEpoch } from '../../../../../use-cases/interface/output/delegation/zerodevMessage.types';
import { pendingDelegations } from '../schema';
import { newCurrentUTCEpoch } from '../../../../../helpers/time/dateTime';

export class DrizzlePendingDelegationRepo implements IPendingDelegationDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(record: {
    userId: string;
    zerodevMessage: ZerodevMessage;
  }): Promise<IPendingDelegation> {
    const now = newCurrentUTCEpoch();
    const expiresAtEpoch = resolveExpiresAtEpoch(record.zerodevMessage);

    const id = uuidv4();
    await this.db.insert(pendingDelegations).values({
      id,
      userId: record.userId,
      zerodevMessage: record.zerodevMessage,
      status: 'pending',
      createdAtEpoch: now,
      expiresAtEpoch,
    });

    return {
      id,
      userId: record.userId,
      zerodevMessage: record.zerodevMessage,
      status: 'pending',
      createdAtEpoch: now,
      expiresAtEpoch,
    };
  }

  async findLatestByUserId(userId: string): Promise<IPendingDelegation | undefined> {
    const rows = await this.db
      .select()
      .from(pendingDelegations)
      .where(eq(pendingDelegations.userId, userId))
      .orderBy(desc(pendingDelegations.createdAtEpoch))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async markSigned(id: string): Promise<void> {
    await this.db
      .update(pendingDelegations)
      .set({ status: 'signed' })
      .where(eq(pendingDelegations.id, id));
  }

  private toRecord(row: typeof pendingDelegations.$inferSelect): IPendingDelegation {
    return {
      id: row.id,
      userId: row.userId,
      zerodevMessage: row.zerodevMessage as ZerodevMessage,
      status: row.status as 'pending' | 'signed' | 'expired',
      createdAtEpoch: row.createdAtEpoch,
      expiresAtEpoch: row.expiresAtEpoch,
    };
  }
}
