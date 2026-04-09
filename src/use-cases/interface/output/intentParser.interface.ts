import { INTENT_ACTION } from "../../../helpers/enums/intentAction.enum";
import type { ToolManifest } from "./toolManifest.types";

export { INTENT_ACTION };

/** Branded type — always a checksummed-or-lowercased 0x address */
export type Address = `0x${string}`;

export interface IntentPackage {
  action:           string;          // INTENT_ACTION value OR dynamic toolId
  fromTokenSymbol?: string;
  toTokenSymbol?:   string;
  amountHuman?:     string;
  slippageBps?:     number;
  recipient?:       Address;
  params?:          Record<string, unknown>; // extra fields for dynamic tools
  confidence:       number;
  rawInput:         string;
}

export interface SimulationReport {
  passed: boolean;
  tokenInDelta: string;
  tokenOutDelta: string;
  gasEstimate: string;
  warnings: string[];
  rawLogs?: string[];
}

export interface IIntentParser {
  parse(
    messages: string[],
    userId: string,
    relevantManifests?: ToolManifest[],   // injected by IntentUseCaseImpl
  ): Promise<IntentPackage | null>;
}
