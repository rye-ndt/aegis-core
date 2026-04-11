import type { IToolManifestDB, IToolManifestRecord } from "../../../../use-cases/interface/output/repository/toolManifest.repo";
import type { ISolver } from "../../../../use-cases/interface/output/solver/solver.interface";
import type { ISolverRegistry } from "../../../../use-cases/interface/output/solver/solverRegistry.interface";
import type { ToolManifest } from "../../../../use-cases/interface/output/toolManifest.types";
import type { IntentPackage } from "../../../../use-cases/interface/output/intentParser.interface";
import { deserializeManifest } from "../../../../use-cases/interface/output/toolManifest.types";
import { ManifestDrivenSolver } from "./manifestSolver/manifestDriven.solver";

export class SolverRegistry implements ISolverRegistry {
  private readonly hardcoded: Map<string, ISolver>;

  constructor(
    solvers: ISolver[] = [],
    private readonly toolManifestDB?: IToolManifestDB,
  ) {
    this.hardcoded = new Map(solvers.map((s) => [s.name, s]));
  }

  async getSolverAsync(action: string): Promise<ISolver | undefined> {
    // 1. Hardcoded builtins first (swap, claim_rewards, etc.)
    const hardcoded = this.hardcoded.get(action);
    if (hardcoded) return hardcoded;

    // 2. DB fallback — treat action as toolId
    if (!this.toolManifestDB) return undefined;
    let record: IToolManifestRecord | undefined;
    try {
      record = await this.toolManifestDB.findByToolId(action);
    } catch {
      return undefined;
    }
    if (!record || !record.isActive) return undefined;

    return new ManifestDrivenSolver(deserializeManifest(record));
  }

  register(action: string, solver: ISolver): void {
    this.hardcoded.set(action, solver);
  }

  async buildFromManifest(
    manifest: ToolManifest,
    intent: IntentPackage,
    userAddress: string,
  ): Promise<{ to: string; data: string; value: string } | null> {
    try {
      const solver = new ManifestDrivenSolver(manifest);
      return await solver.buildCalldata(intent, userAddress);
    } catch {
      return null;
    }
  }
}
