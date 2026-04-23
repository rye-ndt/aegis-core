import type { Artifact, CapabilityCtx } from "../input/capability.interface";

export interface IArtifactRenderer {
  render(artifact: Artifact, ctx: CapabilityCtx): Promise<void>;
}
