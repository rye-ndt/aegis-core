import type { ISolverRegistry } from "../../../../use-cases/interface/output/solver/solverRegistry.interface";
import type { ISolver } from "../../../../use-cases/interface/output/solver/solver.interface";
import type { IntentPackage } from "../../../../use-cases/interface/output/intentParser.interface";

export class SolverRegistry implements ISolverRegistry {
  private readonly solvers = new Map<string, ISolver>();

  register(action: string, solver: ISolver): void {
    this.solvers.set(action, solver);
  }

  getSolver(action: IntentPackage["action"]): ISolver | undefined {
    return this.solvers.get(action);
  }
}
