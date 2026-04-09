import type { ISolver } from "../../../../../use-cases/interface/output/solver/solver.interface";
import type { IntentPackage } from "../../../../../use-cases/interface/output/intentParser.interface";
import type { ToolManifest, ToolStep } from "../../../../../use-cases/interface/output/toolManifest.types";
import { STEP_EXECUTORS, type TemplateContext } from "./stepExecutors";

export class ManifestDrivenSolver implements ISolver {
  readonly name: string;

  constructor(private readonly manifest: ToolManifest) {
    this.name = manifest.toolId;
  }

  async buildCalldata(
    intent: IntentPackage,
    userAddress: string,
  ): Promise<{ to: string; data: string; value: string }> {
    const ctx: TemplateContext = {
      intent,
      user:  { scaAddress: userAddress },
      steps: {},
    };
    let lastOutput: Record<string, string> = {};

    for (const step of this.manifest.steps) {
      const executor = STEP_EXECUTORS[step.kind] as (
        step: ToolStep,
        ctx: TemplateContext,
      ) => Promise<Record<string, string>>;
      const output = await executor(step, ctx);
      ctx.steps[step.name] = output;
      lastOutput = output;
    }

    if (!lastOutput["to"] || !lastOutput["data"]) {
      throw new Error(
        `ManifestDrivenSolver(${this.name}): last step must produce 'to' and 'data'`,
      );
    }
    return {
      to:    lastOutput["to"],
      data:  lastOutput["data"],
      value: lastOutput["value"] ?? "0",
    };
  }
}
