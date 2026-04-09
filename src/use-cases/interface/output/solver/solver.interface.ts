import type { IntentPackage } from "../intentParser.interface";

export interface ISolver {
  name: string;
  buildCalldata(
    intent: IntentPackage,
    userAddress: string,
  ): Promise<{ to: string; data: string; value: string }>;
}
