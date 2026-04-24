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
   * Find the capability that explicitly matches this input via a slash
   * command or callback prefix. Returns null when only the default would
   * apply — callers must resume any pending-collection before falling back
   * to `getDefault()`, so a multi-turn flow is not pre-empted by free text.
   */
  match(input: DispatchInput): Capability | null;
  /** The catch-all free-text capability, if one was registered. */
  getDefault(): Capability | null;
  /** For debugging / admin. */
  listCommands(): Array<{ id: string; command?: INTENT_COMMAND }>;
}
