import type { IntentPackage, SimulationReport } from "./intentParser.interface";
import type { IUserOperation } from "./blockchain/userOperation.interface";

export interface ISimulator {
  simulate(params: {
    userOp: IUserOperation;
    intent: IntentPackage;
    chainId: number;
  }): Promise<SimulationReport>;
}
