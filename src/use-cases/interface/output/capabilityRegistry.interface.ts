import type { Capability, DispatchInput } from "../input/capability.interface";
import type { INTENT_COMMAND } from "../../../helpers/enums/intentCommand.enum";

export interface ICapabilityRegistry {
  register(capability: Capability): void;
  byId(id: string): Capability | undefined;
  /**
   * Find the capability that should handle this input when no prior
   * pending-collection is active. Returns null if nothing matches — the
   * caller may then fall through to a legacy path.
   */
  match(input: DispatchInput): Capability | null;
  /** For debugging / admin. */
  listCommands(): Array<{ id: string; command?: INTENT_COMMAND }>;
}
