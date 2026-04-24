import type {
  CapabilityCtx,
} from "../interface/input/capability.interface";
import type { ICapabilityDispatcher, IDispatchResult } from "../interface/input/capabilityDispatcher.interface";
import type { ICapabilityRegistry } from "../interface/output/capabilityRegistry.interface";
import type { IPendingCollectionStore } from "../interface/output/pendingCollectionStore.interface";
import type { IArtifactRenderer } from "../interface/output/artifactRenderer.interface";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("capabilityDispatcher");
const PENDING_TTL_SECONDS = 600;

export class CapabilityDispatcher implements ICapabilityDispatcher {
  constructor(
    private readonly registry: ICapabilityRegistry,
    private readonly renderer: IArtifactRenderer,
    private readonly pending: IPendingCollectionStore,
  ) {}

  async handle(partial: Omit<CapabilityCtx, "emit">): Promise<IDispatchResult> {
    const ctx: CapabilityCtx = {
      ...partial,
      emit: (artifact) => this.renderer.render(artifact, ctx),
    };
    const prior = await this.pending.get(ctx.channelId);
    const now = newCurrentUTCEpoch();

    // Priority order:
    //   1. A fresh slash-command / callback match pre-empts any stale flow.
    //   2. Otherwise, resume an active pending-collection.
    //   3. Otherwise, fall back to the default free-text capability.
    // This ordering ensures mid-flow replies like "8" (a disambiguation
    // choice) are not stolen by the default assistant LLM capability.
    const matchFirst = this.registry.match(ctx.input);

    let capability = matchFirst;
    let resuming: Record<string, unknown> | undefined;
    let resolution: "matched" | "resumed" | "default" | "none";
    if (matchFirst) {
      resolution = "matched";
    } else if (prior && prior.expiresAt > now) {
      capability = this.registry.byId(prior.capabilityId) ?? null;
      resuming = prior.state;
      resolution = "resumed";
    } else {
      capability = this.registry.getDefault();
      resolution = capability ? "default" : "none";
    }

    log.debug(
      { choice: resolution, capabilityId: capability?.id ?? null, channelId: ctx.channelId, hasPrior: !!prior },
      "capability resolved",
    );

    if (!capability) {
      // No capability matched and nothing pending — caller may fall through
      // to a legacy path (e.g. the assistant LLM loop).
      return { handled: false };
    }

    // If we matched a fresh command, any prior pending state for this
    // channel is abandoned.
    if (matchFirst && prior) {
      log.debug({ choice: "pending-abandoned", channelId: ctx.channelId, priorCapabilityId: prior.capabilityId }, "abandoning stale pending");
      await this.pending.clear(ctx.channelId);
      resuming = undefined;
    }

    log.info({ step: "capability-invoke", capabilityId: capability.id, channelId: ctx.channelId, resuming: !!resuming }, "invoking capability");
    let result;
    try {
      result = await capability.collect(ctx, resuming);
    } catch (err) {
      log.error({ err, capabilityId: capability.id, channelId: ctx.channelId }, "capability.collect threw");
      throw err;
    }

    if (result.kind === "terminal") {
      await this.pending.clear(ctx.channelId);
      await this.renderer.render(result.artifact, ctx);
      log.info({ step: "capability-done", capabilityId: capability.id, kind: "terminal" }, "capability complete");
      return { handled: true };
    }

    if (result.kind === "ask") {
      await this.pending.save(ctx.channelId, {
        capabilityId: capability.id,
        state: result.state,
        expiresAt: now + PENDING_TTL_SECONDS,
      });
      await this.renderer.render(
        {
          kind: "chat",
          text: result.question,
          keyboard: result.keyboard,
          parseMode: result.parseMode,
        },
        ctx,
      );
      log.info({ step: "capability-done", capabilityId: capability.id, kind: "ask" }, "capability asking follow-up");
      return { handled: true };
    }

    // ok
    await this.pending.clear(ctx.channelId);
    let artifact;
    try {
      artifact = await capability.run(result.params, ctx);
    } catch (err) {
      log.error({ err, capabilityId: capability.id, channelId: ctx.channelId }, "capability.run threw");
      throw err;
    }
    await this.renderer.render(artifact, ctx);
    log.info({ step: "capability-done", capabilityId: capability.id, kind: "ok" }, "capability complete");
    return { handled: true };
  }
}
