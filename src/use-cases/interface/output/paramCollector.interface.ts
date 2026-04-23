import type { CapabilityCtx, CollectResult } from "../input/capability.interface";

/**
 * Reusable param-collection strategy. Capabilities compose one or more of
 * these instead of each re-implementing regex parsing, LLM extraction, or
 * disambiguation loops.
 */
export interface IParamCollector<P> {
  collect(
    ctx: CapabilityCtx,
    resuming?: Record<string, unknown>,
  ): Promise<CollectResult<P>>;
}
