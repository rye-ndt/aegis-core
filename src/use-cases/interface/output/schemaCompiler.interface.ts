import type { ToolManifest } from "./toolManifest.types";

export interface CompileResult {
  params: Record<string, unknown>;
  missingQuestion: string | null;
  tokenSymbols: { from?: string; to?: string };
}

export interface ISchemaCompiler {
  compile(opts: {
    manifest: ToolManifest;
    messages: string[];
    autoFilled: Record<string, unknown>;
    partialParams: Record<string, unknown>;
  }): Promise<CompileResult>;
}
