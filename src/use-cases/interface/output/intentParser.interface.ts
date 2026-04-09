import { INTENT_ACTION } from "../../../helpers/enums/intentAction.enum";

export { INTENT_ACTION };

export interface IntentPackage {
  action: INTENT_ACTION;
  tokenIn?: {
    symbol: string;
    address: string;
    decimals: number;
    amountHuman: string;
    amountRaw: string;
  };
  tokenOut?: {
    symbol: string;
    address: string;
    decimals: number;
  };
  slippageBps?: number;
  recipient?: string;
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
  parse(input: string, userId: string): Promise<IntentPackage>;
}
