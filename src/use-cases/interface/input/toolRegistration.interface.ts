import type { ToolManifest } from "../output/toolManifest.types";

export interface RegisterToolResult {
  toolId:    string;
  id:        string;
  createdAt: number;
  indexed:   boolean;
}

export interface IToolRegistrationUseCase {
  register(manifest: ToolManifest): Promise<RegisterToolResult>;
  list(chainId?: number): Promise<ToolManifest[]>;
  deactivate(toolId: string): Promise<void>;
}
