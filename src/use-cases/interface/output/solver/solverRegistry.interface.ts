import type { ISolver } from "./solver.interface";
import type { ToolManifest } from "../toolManifest.types";
import type { IntentPackage } from "../intentParser.interface";

export interface ISolverRegistry {
  getSolverAsync(action: string): Promise<ISolver | undefined>;
  register(action: string, solver: ISolver): void;
  buildFromManifest(
    manifest: ToolManifest,
    intent: IntentPackage,
    userAddress: string,
  ): Promise<{ to: string; data: string; value: string } | null>;
}
