import type { Capability, DispatchInput } from "../interface/input/capability.interface";
import type { ICapabilityRegistry } from "../interface/output/capabilityRegistry.interface";
import type { INTENT_COMMAND } from "../../helpers/enums/intentCommand.enum";
import { parseIntentCommand } from "../../helpers/enums/intentCommand.enum";

export class CapabilityRegistry implements ICapabilityRegistry {
  private readonly byIdMap = new Map<string, Capability>();
  private readonly byCommand = new Map<string, Capability>();
  private readonly byCallbackPrefix: Array<{ prefix: string; capability: Capability }> = [];
  private defaultCapability: Capability | null = null;

  register(capability: Capability): void {
    if (this.byIdMap.has(capability.id)) {
      throw new Error(`Capability id conflict: ${capability.id}`);
    }
    this.byIdMap.set(capability.id, capability);

    const { command, callbackPrefix } = capability.triggers;
    if (command) {
      if (this.byCommand.has(command)) {
        throw new Error(`Command conflict for ${command}: ${capability.id} vs ${this.byCommand.get(command)!.id}`);
      }
      this.byCommand.set(command, capability);
    }
    if (callbackPrefix) {
      // Longest-prefix-first so "buy_vip" wins over "buy" when both are registered.
      this.byCallbackPrefix.push({ prefix: callbackPrefix, capability });
      this.byCallbackPrefix.sort((a, b) => b.prefix.length - a.prefix.length);
    }
  }

  registerDefault(capability: Capability): void {
    if (this.defaultCapability) {
      throw new Error(
        `Default capability already set: ${this.defaultCapability.id} — cannot register ${capability.id}`,
      );
    }
    if (!this.byIdMap.has(capability.id)) {
      this.byIdMap.set(capability.id, capability);
    }
    this.defaultCapability = capability;
  }

  byId(id: string): Capability | undefined {
    return this.byIdMap.get(id);
  }

  match(input: DispatchInput): Capability | null {
    if (input.kind === "text") {
      const command = parseIntentCommand(input.text);
      if (command) {
        const cap = this.byCommand.get(command);
        if (cap) return cap;
      }
      return this.defaultCapability;
    }
    // callback
    for (const { prefix, capability } of this.byCallbackPrefix) {
      if (input.data === prefix || input.data.startsWith(`${prefix}:`)) {
        return capability;
      }
    }
    return null;
  }

  listCommands(): Array<{ id: string; command?: INTENT_COMMAND }> {
    return Array.from(this.byIdMap.values()).map((c) => ({
      id: c.id,
      command: c.triggers.command,
    }));
  }
}
