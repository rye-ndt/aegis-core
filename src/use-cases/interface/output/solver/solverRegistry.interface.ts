import type { IntentPackage } from "../intentParser.interface";
import type { ISolver } from "./solver.interface";

export interface ISolverRegistry {
  getSolver(action: IntentPackage["action"]): ISolver | undefined;
  register(action: string, solver: ISolver): void;
}
