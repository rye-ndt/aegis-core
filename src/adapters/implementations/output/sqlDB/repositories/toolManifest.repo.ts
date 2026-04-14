import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IToolManifestDB,
  IToolManifestRecord,
} from "../../../../../use-cases/interface/output/repository/toolManifest.repo";
import { toolManifests } from "../schema";

export class DrizzleToolManifestRepo implements IToolManifestDB {
  constructor(private readonly db: NodePgDatabase) {}

  async create(manifest: IToolManifestRecord): Promise<void> {
    await this.db.insert(toolManifests).values({
      id:               manifest.id,
      toolId:           manifest.toolId,
      category:         manifest.category,
      name:             manifest.name,
      description:      manifest.description,
      protocolName:     manifest.protocolName,
      tags:             manifest.tags,
      priority:         manifest.priority,
      isDefault:        manifest.isDefault,
      inputSchema:      manifest.inputSchema,
      steps:            manifest.steps,
      preflightPreview: manifest.preflightPreview ?? null,
      revenueWallet:    manifest.revenueWallet ?? null,
      isVerified:       manifest.isVerified,
      isActive:         manifest.isActive,
      chainIds:         manifest.chainIds,
      createdAtEpoch:   manifest.createdAtEpoch,
      updatedAtEpoch:   manifest.updatedAtEpoch,
    });
  }

  async findByToolId(toolId: string): Promise<IToolManifestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(toolManifests)
      .where(eq(toolManifests.toolId, toolId))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async findById(id: string): Promise<IToolManifestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(toolManifests)
      .where(eq(toolManifests.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async listActive(chainId?: number): Promise<IToolManifestRecord[]> {
    const conditions: SQL[] = [eq(toolManifests.isActive, true)];
    const chainCondition = this.chainIdCondition(chainId);
    if (chainCondition) conditions.push(chainCondition);
    const rows = await this.db.select().from(toolManifests).where(and(...conditions));
    return rows.map((r) => this.toRecord(r));
  }

  async deactivate(toolId: string): Promise<void> {
    await this.db
      .update(toolManifests)
      .set({ isActive: false })
      .where(eq(toolManifests.toolId, toolId));
  }

  async findByToolIds(toolIds: string[]): Promise<IToolManifestRecord[]> {
    if (toolIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(toolManifests)
      .where(and(eq(toolManifests.isActive, true), inArray(toolManifests.toolId, toolIds)));
    return rows.map((r) => this.toRecord(r));
  }

  // Fallback keyword search used when vector index is unavailable.
  async search(
    query: string,
    options: { limit: number; category?: string; chainId?: number },
  ): Promise<IToolManifestRecord[]> {
    const pattern = `%${query}%`;
    const conditions = [
      eq(toolManifests.isActive, true),
      or(
        ilike(toolManifests.name, pattern),
        ilike(toolManifests.description, pattern),
        ilike(toolManifests.protocolName, pattern),
        ilike(toolManifests.tags, pattern),
      ),
    ];
    if (options.category != null) {
      conditions.push(eq(toolManifests.category, options.category));
    }
    const chainCondition = this.chainIdCondition(options.chainId);
    if (chainCondition) conditions.push(chainCondition);
    const rows = await this.db
      .select()
      .from(toolManifests)
      .where(and(...conditions))
      .orderBy(desc(toolManifests.priority), desc(toolManifests.isDefault))
      .limit(options.limit);
    return rows.map((r) => this.toRecord(r));
  }

  private chainIdCondition(chainId: number | undefined): SQL | undefined {
    return chainId != null ? ilike(toolManifests.chainIds, `%${chainId}%`) : undefined;
  }

  private toRecord(row: typeof toolManifests.$inferSelect): IToolManifestRecord {
    return {
      id:               row.id,
      toolId:           row.toolId,
      category:         row.category,
      name:             row.name,
      description:      row.description,
      protocolName:     row.protocolName,
      tags:             row.tags,
      priority:         row.priority,
      isDefault:        row.isDefault,
      inputSchema:      row.inputSchema,
      steps:            row.steps,
      preflightPreview: row.preflightPreview,
      revenueWallet:    row.revenueWallet,
      isVerified:       row.isVerified,
      isActive:         row.isActive,
      chainIds:         row.chainIds,
      requiredFields:   row.requiredFields ?? null,
      finalSchema:      row.finalSchema    ?? null,
      createdAtEpoch:   row.createdAtEpoch,
      updatedAtEpoch:   row.updatedAtEpoch,
    };
  }
}
