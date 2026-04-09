import { isAddress } from "viem";
import { INTENT_ACTION } from "../../helpers/enums/intentAction.enum";
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import type { IToolRegistrationUseCase, RegisterToolResult } from "../interface/input/toolRegistration.interface";
import type { IToolManifestDB } from "../interface/output/repository/toolManifest.repo";
import { ToolManifestSchema, deserializeManifest, type ToolManifest } from "../interface/output/toolManifest.types";

const RESERVED_ACTIONS = new Set<string>(Object.values(INTENT_ACTION));

export class ToolRegistrationUseCase implements IToolRegistrationUseCase {
  constructor(private readonly toolManifestDB: IToolManifestDB) {}

  async register(manifest: ToolManifest): Promise<RegisterToolResult> {
    // 1. Validate with Zod — throws ZodError on failure
    ToolManifestSchema.parse(manifest);

    // 2. Reject toolIds that collide with built-in INTENT_ACTION values
    if (RESERVED_ACTIONS.has(manifest.toolId)) {
      throw new Error(`TOOL_ID_TAKEN: "${manifest.toolId}" is a reserved action name`);
    }

    // 3. Reject if toolId already exists
    const existing = await this.toolManifestDB.findByToolId(manifest.toolId);
    if (existing) {
      throw new Error(`TOOL_ID_TAKEN: a tool with toolId "${manifest.toolId}" already exists`);
    }

    // 4. Validate abi_encode step contract addresses
    for (const step of manifest.steps) {
      if (step.kind === "abi_encode" && !isAddress(step.contractAddress)) {
        throw new Error(`Invalid contractAddress "${step.contractAddress}" in step "${step.name}"`);
      }
    }

    const now = newCurrentUTCEpoch();
    const id = newUuid();

    // 5. Serialize JSON fields and create the record
    await this.toolManifestDB.create({
      id,
      toolId:           manifest.toolId,
      category:         manifest.category,
      name:             manifest.name,
      description:      manifest.description,
      protocolName:     manifest.protocolName,
      tags:             JSON.stringify(manifest.tags),
      priority:         manifest.priority,
      isDefault:        manifest.isDefault,
      inputSchema:      JSON.stringify(manifest.inputSchema),
      steps:            JSON.stringify(manifest.steps),
      preflightPreview: manifest.preflightPreview ? JSON.stringify(manifest.preflightPreview) : null,
      revenueWallet:    manifest.revenueWallet ?? null,
      isVerified:       false,
      isActive:         true,
      chainIds:         JSON.stringify(manifest.chainIds),
      createdAtEpoch:   now,
      updatedAtEpoch:   now,
    });

    return { toolId: manifest.toolId, id, createdAt: now };
  }

  async list(chainId?: number): Promise<ToolManifest[]> {
    const records = await this.toolManifestDB.listActive(chainId);
    return records.map(deserializeManifest);
  }
}
