import type { ToolManifest } from "../output/toolManifest.types";

export interface RegisterToolResult {
  toolId:    string;
  id:        string;
  createdAt: number;
}

export interface IToolRegistrationUseCase {
  register(manifest: ToolManifest): Promise<RegisterToolResult>;
  list(chainId?: number): Promise<ToolManifest[]>;
}
