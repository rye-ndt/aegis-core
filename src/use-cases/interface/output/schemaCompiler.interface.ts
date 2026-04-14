import type { ToolManifest } from "./toolManifest.types";

export interface CompileResult {
  params:          Record<string, unknown>;
  missingQuestion: string | null;
  tokenSymbols:    { from?: string; to?: string };
  telegramHandle?: string; // e.g. "rye-ndt" (without @), if user mentions a person handle as recipient
  /**
   * Present only when the tool uses the dual-schema model.
   * Maps each RESOLVER_FIELD key to the raw human-provided value
   * (before resolution). The resolver engine (Part 2) reads this.
   */
  resolverFields?: Partial<Record<string, string>>;
}

export interface ISchemaCompiler {
  compile(opts: {
    manifest: ToolManifest;
    messages: string[];
    autoFilled: Record<string, unknown>;
    partialParams: Record<string, unknown>;
  }): Promise<CompileResult>;

  generateQuestion(opts: {
    manifest: ToolManifest;
    missingFields: string[];
  }): Promise<string>;
}
