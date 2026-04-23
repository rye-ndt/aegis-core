import type { ISolver } from "./solver.interface";

export interface ISolverRegistry {
  getSolverAsync(action: string): Promise<ISolver | undefined>;
  register(action: string, solver: ISolver): void;
}
