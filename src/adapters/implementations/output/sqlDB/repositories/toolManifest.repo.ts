import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IToolManifest,
  IToolManifestDB,
} from "../../../../../use-cases/interface/output/repository/toolManifest.repo";
import { SOLVER_TYPE } from "../../../../../helpers/enums/solverType.enum";
import { toolManifests } from "../schema";

export class DrizzleToolManifestRepo implements IToolManifestDB {
  constructor(private readonly db: NodePgDatabase) {}

  async upsert(manifest: IToolManifest): Promise<void> {
    await this.db
      .insert(toolManifests)
      .values({
        id: manifest.id,
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        solverType: manifest.solverType,
        endpointUrl: manifest.endpointUrl ?? null,
        inputSchema: manifest.inputSchema,
        outputSchema: manifest.outputSchema,
        contributorAddress: manifest.contributorAddress ?? null,
        revShareBps: manifest.revShareBps,
        isActive: manifest.isActive,
        chainIds: manifest.chainIds,
        createdAtEpoch: manifest.createdAtEpoch,
        updatedAtEpoch: manifest.updatedAtEpoch,
      })
      .onConflictDoUpdate({
        target: toolManifests.name,
        set: {
          displayName: manifest.displayName,
          description: manifest.description,
          version: manifest.version,
          solverType: manifest.solverType,
          endpointUrl: manifest.endpointUrl ?? null,
          inputSchema: manifest.inputSchema,
          outputSchema: manifest.outputSchema,
          contributorAddress: manifest.contributorAddress ?? null,
          revShareBps: manifest.revShareBps,
          isActive: manifest.isActive,
          chainIds: manifest.chainIds,
          updatedAtEpoch: manifest.updatedAtEpoch,
        },
      });
  }

  async findByName(name: string): Promise<IToolManifest | undefined> {
    const rows = await this.db
      .select()
      .from(toolManifests)
      .where(eq(toolManifests.name, name))
      .limit(1);
    if (!rows[0]) return undefined;
    return this.toRecord(rows[0]);
  }

  async listActive(chainId?: number): Promise<IToolManifest[]> {
    const rows = await this.db
      .select()
      .from(toolManifests)
      .where(eq(toolManifests.isActive, true));
    if (chainId == null) return rows.map((r) => this.toRecord(r));
    return rows
      .filter((r) => {
        try {
          const ids: number[] = JSON.parse(r.chainIds);
          return ids.includes(chainId);
        } catch {
          return false;
        }
      })
      .map((r) => this.toRecord(r));
  }

  private toRecord(row: typeof toolManifests.$inferSelect): IToolManifest {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      version: row.version,
      solverType: row.solverType as SOLVER_TYPE,
      endpointUrl: row.endpointUrl,
      inputSchema: row.inputSchema,
      outputSchema: row.outputSchema,
      contributorAddress: row.contributorAddress,
      revShareBps: row.revShareBps,
      isActive: row.isActive,
      chainIds: row.chainIds,
      createdAtEpoch: row.createdAtEpoch,
      updatedAtEpoch: row.updatedAtEpoch,
    };
  }
}
