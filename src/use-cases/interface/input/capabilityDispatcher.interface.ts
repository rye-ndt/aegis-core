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
  /**
   * Skip collect() and re-enter `capability.run()` directly with already-
   * resolved params. Used by the Aegis-Guard approval flow to auto-resume the
   * original /send or /swap once the user approves the missing delegation.
   *
   * Returns `{ handled: false }` if no capability with that id is registered.
   */
  resume(input: {
    capabilityId: string;
    params: Record<string, unknown>;
    ctx: Omit<CapabilityCtx, "emit" | "input">;
  }): Promise<IDispatchResult>;
}
