import type { ICommandMappingUseCase } from "../interface/input/commandMapping.interface";
import type { ICommandToolMappingDB } from "../interface/output/repository/commandToolMapping.repo";
import type { IToolManifestDB } from "../interface/output/repository/toolManifest.repo";
import { INTENT_COMMAND } from "../../helpers/enums/intentCommand.enum";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";

const KNOWN_COMMANDS = new Set<string>(Object.values(INTENT_COMMAND));

/**
 * Normalises a bare word ("buy") into the slash-prefixed form ("/buy").
 * Returns null if the result is not a recognised INTENT_COMMAND value.
 */
function normaliseCommand(bare: string): INTENT_COMMAND | null {
  const withSlash = `/${bare.trim().toLowerCase().replace(/^\//, "")}`;
  return KNOWN_COMMANDS.has(withSlash) ? (withSlash as INTENT_COMMAND) : null;
}

export class CommandMappingUseCase implements ICommandMappingUseCase {
  constructor(
    private readonly commandMappingDB: ICommandToolMappingDB,
    private readonly toolManifestDB: IToolManifestDB,
  ) {}

  async setMapping(
    bareCommand: string,
    toolId: string,
  ): Promise<{ command: string; toolId: string }> {
    const normalised = normaliseCommand(bareCommand);
    if (!normalised) {
      throw new Error(
        `UNKNOWN_COMMAND: "${bareCommand}" is not a recognised intent command. ` +
          `Known commands: ${[...KNOWN_COMMANDS].map((c) => c.slice(1)).join(", ")}`,
      );
    }

    const tool = await this.toolManifestDB.findByToolId(toolId);
    if (!tool || !tool.isActive) {
      throw new Error(`TOOL_NOT_FOUND: no active tool with toolId="${toolId}"`);
    }

    const now = newCurrentUTCEpoch();
    // Store the bare word (no slash) in the DB
    const bare = normalised.slice(1);
    await this.commandMappingDB.upsert({
      command: bare,
      toolId,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    return { command: bare, toolId };
  }

  async getMapping(bareCommand: string): Promise<string | null> {
    const normalised = normaliseCommand(bareCommand);
    if (!normalised) return null;
    const record = await this.commandMappingDB.findByCommand(normalised.slice(1));
    return record?.toolId ?? null;
  }

  async listMappings(): Promise<Array<{ command: string; toolId: string }>> {
    const records = await this.commandMappingDB.listAll();
    return records.map((r) => ({ command: r.command, toolId: r.toolId }));
  }

  async deleteMapping(bareCommand: string): Promise<void> {
    const normalised = normaliseCommand(bareCommand);
    const bare = normalised ? normalised.slice(1) : bareCommand.trim();
    await this.commandMappingDB.delete(bare);
  }
}
