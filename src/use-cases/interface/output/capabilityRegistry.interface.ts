import type { Capability, DispatchInput } from "../input/capability.interface";
import type { INTENT_COMMAND } from "../../../helpers/enums/intentCommand.enum";

export interface ICapabilityRegistry {
  register(capability: Capability): void;
  /**
   * Register a capability as the catch-all for free text that matches no
   * slash command and no active pending-collection. Only one default may be
   * set. Callback inputs never reach the default.
   */
  registerDefault(capability: Capability): void;
  byId(id: string): Capability | undefined;
  /**
   * Find the capability that should handle this input when no prior
   * pending-collection is active. Returns null if nothing matches — the
   * caller may then fall through to a legacy path.
   *
   * If a default capability is registered, `match` on a text input that
   * doesn't match a command falls through to it rather than returning null.
   */
  match(input: DispatchInput): Capability | null;
  /** For debugging / admin. */
  listCommands(): Array<{ id: string; command?: INTENT_COMMAND }>;
}
