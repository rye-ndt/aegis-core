import { isAddress } from "viem";
import { INTENT_ACTION } from "../../helpers/enums/intentAction.enum";
import { newUuid } from "../../helpers/uuid";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import type { IToolRegistrationUseCase, RegisterToolResult } from "../interface/input/toolRegistration.interface";
import type { IToolManifestDB } from "../interface/output/repository/toolManifest.repo";
import type { IToolIndexService } from "../interface/output/toolIndex.interface";
import { ToolManifestSchema, deserializeManifest, type ToolManifest } from "../interface/output/toolManifest.types";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("toolRegistration");
const RESERVED_ACTIONS = new Set<string>(Object.values(INTENT_ACTION));

function buildEmbeddingText(manifest: ToolManifest): string {
  return [
    manifest.name,
    manifest.description,
    `Protocol: ${manifest.protocolName}`,
    `Tags: ${manifest.tags.join(", ")}`,
    `Category: ${manifest.category}`,
  ].join(". ");
}

export class ToolRegistrationUseCase implements IToolRegistrationUseCase {
  constructor(
    private readonly toolManifestDB: IToolManifestDB,
    private readonly toolIndexService?: IToolIndexService,
  ) {}

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

    // 5. Persist to DB
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

    // 6. Index in vector store — best-effort; never blocks registration
    let indexed = false;
    if (this.toolIndexService) {
      try {
        await this.toolIndexService.index({
          id,
          toolId: manifest.toolId,
          text: buildEmbeddingText(manifest),
          category: manifest.category,
          chainIds: manifest.chainIds,
        });
        indexed = true;
      } catch (err) {
        log.error({ err, toolId: manifest.toolId }, "vector index failed (non-blocking)");
      }
    }

    return { toolId: manifest.toolId, id, createdAt: now, indexed };
  }

  async deactivate(toolId: string): Promise<void> {
    const record = await this.toolManifestDB.findByToolId(toolId);
    if (!record) throw new Error(`TOOL_NOT_FOUND: "${toolId}" does not exist`);

    // DB deactivation first — if vector delete fails, the tool is already inactive
    // and will be filtered out by findByToolIds (isActive=true guard).
    await this.toolManifestDB.deactivate(toolId);

    if (this.toolIndexService) {
      try {
        await this.toolIndexService.delete(record.id);
      } catch (err) {
        log.error({ err, toolId }, "vector delete failed (tool already deactivated in DB)");
      }
    }
  }

  async list(chainId?: number): Promise<ToolManifest[]> {
    const records = await this.toolManifestDB.listActive(chainId);
    return records.map(deserializeManifest);
  }
}
