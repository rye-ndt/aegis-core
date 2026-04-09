import { INTENT_ACTION } from "../../../helpers/enums/intentAction.enum";

export { INTENT_ACTION };

/** Branded type — always a checksummed-or-lowercased 0x address */
export type Address = `0x${string}`;

export interface IntentPackage {
  action: INTENT_ACTION;
  fromTokenSymbol?: string;
  toTokenSymbol?: string;
  amountHuman?: string;
  slippageBps?: number;
  recipient?: Address;
  confidence: number;
  rawInput: string;
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
  parse(messages: string[], userId: string): Promise<IntentPackage | null>;
}
