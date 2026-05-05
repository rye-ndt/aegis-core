/**
 * Data shapes consumed by manifest-driven solvers (`ISolver.buildCalldata`).
 * The legacy `IIntentParser` (LLM NL→IntentPackage) was removed when
 * natural-language intents were unified onto the slash-command capability
 * dispatcher via `route_intent`. Capabilities now construct `IntentPackage`
 * directly inside `IntentUseCase.buildRequestBody`.
 */

/** Branded type — always a checksummed-or-lowercased 0x address */
export type Address = `0x${string}`;

export interface IntentPackage {
  action:           string;          // dynamic toolId (manifest)
  fromTokenSymbol?: string;
  toTokenSymbol?:   string;
  amountHuman?:     string;
  slippageBps?:     number;
  recipient?:       Address;
  params?:          Record<string, unknown>; // extra fields for dynamic tools
  confidence:       number;
  rawInput:         string;
}
