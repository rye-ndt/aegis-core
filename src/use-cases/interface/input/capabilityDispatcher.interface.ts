import type { CapabilityCtx } from "./capability.interface";

export interface IDispatchResult {
  /** True if a capability handled this input (whether by asking or running). */
  handled: boolean;
}

/**
 * Single entry point every input adapter funnels through. Replaces the
 * ad-hoc branching that used to live in telegram/handler.ts.
 *
 * Callers provide a `CapabilityCtx` minus `emit` — the dispatcher fills in
 * `emit` by binding it to its renderer.
 */
export interface ICapabilityDispatcher {
  handle(ctx: Omit<CapabilityCtx, "emit">): Promise<IDispatchResult>;
}
