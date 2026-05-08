import type {
  CapabilityCtx,
} from "../interface/input/capability.interface";
import type { ICapabilityDispatcher, IDispatchResult } from "../interface/input/capabilityDispatcher.interface";
import type { ICapabilityRegistry } from "../interface/output/capabilityRegistry.interface";
import type { IPendingCollectionStore } from "../interface/output/pendingCollectionStore.interface";
import type { IArtifactRenderer } from "../interface/output/artifactRenderer.interface";
import type { ISigningRequestUseCase } from "../interface/input/signingRequest.interface";
import type { IMiniAppRequestCache } from "../interface/output/cache/miniAppRequest.cache";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { createLogger } from "../../helpers/observability/logger";

const log = createLogger("capabilityDispatcher");
const PENDING_TTL_SECONDS = 600;

export class CapabilityDispatcher implements ICapabilityDispatcher {
  // One-active-dispatch-per-user supersession. Newer input aborts the
  // controller for the prior dispatch so its render output and pending writes
  // are dropped instead of racing the new dispatch.
  private readonly activeByUserId = new Map<string, AbortController>();

  constructor(
    private readonly registry: ICapabilityRegistry,
    private readonly renderer: IArtifactRenderer,
    private readonly pending: IPendingCollectionStore,
    private readonly signingRequestUseCase?: ISigningRequestUseCase,
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
  ) {}

  async handle(partial: Omit<CapabilityCtx, "emit">): Promise<IDispatchResult> {
    const { userId, channelId } = partial;

    // Supersede any in-flight dispatch for this user. Three layers:
    //   1. Abort the prior in-process AbortController so post-completion
    //      renders / pending writes from the old dispatch are dropped.
    //   2. Flip the prior dispatch's pending signing-request cache records
    //      to `expired` so a late FE /response cannot re-trigger
    //      `notifyResolved` and render a phantom success/failure card (e.g.
    //      "insufficient balance" for a request the user already abandoned).
    //   3. Unblock any in-process `waitFor` polls so the prior promise
    //      unwinds quickly instead of pinning memory until cache TTL.
    // (2) and (3) happen inside `cancelPendingForUser`.
    //
    // Publish the new controller synchronously (before any await): under
    // @grammyjs/runner, two updates from the same user can enter `handle()`
    // concurrently, so a third dispatch must observe the second's controller
    // — not the first's — when deciding what to abort.
    const priorController = this.activeByUserId.get(userId);
    const controller = new AbortController();
    this.activeByUserId.set(userId, controller);
    if (priorController) {
      priorController.abort();
      log.info(
        { step: "dispatch-superseded", userId, channelId },
        "aborting prior dispatch — newer input arrived",
      );
    }
    // Both caches must be cleared together: the BE-side `signingRequestCache`
    // backs `resolveRequest` (so notifyResolved cannot fire phantom cards),
    // and the FE-side `miniAppRequestCache` backs `GET /request/:id` and the
    // `findNextPendingSignForUser` queue (so the mini-app cannot load and
    // sign a stale request). Run them in parallel — they are independent
    // Redis keyspaces and ordering does not matter.
    if (this.signingRequestUseCase || this.miniAppRequestCache) {
      const cancellations: Promise<unknown>[] = [];
      if (this.signingRequestUseCase) {
        cancellations.push(
          this.signingRequestUseCase.cancelPendingForUser(userId).catch((err) => {
            log.error(
              { err, userId, channelId, cache: "signingRequest" },
              "cancelPendingForUser failed — proceeding anyway",
            );
          }),
        );
      }
      if (this.miniAppRequestCache) {
        cancellations.push(
          this.miniAppRequestCache.cancelPendingForUser(userId).catch((err) => {
            log.error(
              { err, userId, channelId, cache: "miniAppRequest" },
              "cancelPendingForUser failed — proceeding anyway",
            );
          }),
        );
      }
      await Promise.all(cancellations);
    }

    const signal = controller.signal;
    const dropped = (): IDispatchResult => {
      log.info(
        { step: "dispatch-aborted", userId, channelId },
        "dropping superseded dispatch output",
      );
      return { handled: true };
    };

    const ctx: CapabilityCtx = {
      ...partial,
      signal,
      emit: async (artifact) => {
        if (signal.aborted) return;
        await this.renderer.render(artifact, ctx);
      },
    };

    try {
      const prior = await this.pending.get(ctx.channelId);
      if (signal.aborted) return dropped();
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
      let resolution: "matched" | "resumed" | "default" | "none" | "resume-stale";
      if (matchFirst) {
        resolution = "matched";
      } else if (prior && prior.expiresAt > now) {
        const resumed = this.registry.byId(prior.capabilityId) ?? null;
        if (resumed) {
          capability = resumed;
          resuming = prior.state;
          resolution = "resumed";
        } else {
          // Pending slot points at a capability that's no longer registered
          // (e.g. registration changed between save and now). Drop the stale
          // slot and fall through to the default free-text capability rather
          // than returning handled:false, which would surface as a confusing
          // "I didn't understand" until the 600s TTL expires.
          log.warn(
            { channelId: ctx.channelId, staleCapabilityId: prior.capabilityId },
            "pending capability id not registered — clearing and falling back to default",
          );
          await this.pending.clear(ctx.channelId);
          if (signal.aborted) return dropped();
          capability = this.registry.getDefault();
          resolution = capability ? "resume-stale" : "none";
        }
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
        if (signal.aborted) return dropped();
        resuming = undefined;
      }

      log.info({ step: "capability-invoke", capabilityId: capability.id, channelId: ctx.channelId, resuming: !!resuming }, "invoking capability");
      let result;
      try {
        result = await capability.collect(ctx, resuming);
      } catch (err) {
        if (signal.aborted) return dropped();
        log.error({ err, capabilityId: capability.id, channelId: ctx.channelId }, "capability.collect threw");
        throw err;
      }
      if (signal.aborted) return dropped();

      if (result.kind === "terminal") {
        await this.pending.clear(ctx.channelId);
        if (signal.aborted) return dropped();
        await this.renderer.render(result.artifact, ctx);
        log.info({ step: "capability-done", capabilityId: capability.id, kind: "terminal" }, "capability complete");
        return { handled: true };
      }

      if (result.kind === "ask") {
        const shouldPersist = result.persist !== false;
        if (shouldPersist) {
          await this.pending.save(ctx.channelId, {
            capabilityId: capability.id,
            state: result.state,
            expiresAt: now + PENDING_TTL_SECONDS,
          });
        } else {
          // Non-persisting ask: clear any prior pending so a stale resume can't
          // fire on the user's next message. Continuation is expected via a
          // keyboard callback, which matches through registry.match — not resume.
          await this.pending.clear(ctx.channelId);
        }
        if (signal.aborted) return dropped();
        await this.renderer.render(
          {
            kind: "chat",
            text: result.question,
            keyboard: result.keyboard,
            parseMode: result.parseMode,
          },
          ctx,
        );
        log.info({ step: "capability-done", capabilityId: capability.id, kind: "ask", persist: shouldPersist }, "capability asking follow-up");
        return { handled: true };
      }

      // ok
      await this.pending.clear(ctx.channelId);
      if (signal.aborted) return dropped();
      let artifact;
      try {
        artifact = await capability.run(result.params, ctx);
      } catch (err) {
        if (signal.aborted) return dropped();
        log.error({ err, capabilityId: capability.id, channelId: ctx.channelId }, "capability.run threw");
        throw err;
      }
      if (signal.aborted) return dropped();
      await this.renderer.render(artifact, ctx);
      log.info({ step: "capability-done", capabilityId: capability.id, kind: "ok" }, "capability complete");
      return { handled: true };
    } finally {
      // Only delete if we're still the active controller — a newer dispatch
      // may have already overwritten the entry, and we must not clobber it.
      if (this.activeByUserId.get(userId) === controller) {
        this.activeByUserId.delete(userId);
      }
    }
  }

  async resume(input: {
    capabilityId: string;
    params: Record<string, unknown>;
    ctx: Omit<CapabilityCtx, "emit" | "input">;
  }): Promise<IDispatchResult> {
    // resume() is invoked when a signing request resolves — the user already
    // signed, so the resulting render must reach them even if they have since
    // typed a new command. We deliberately do NOT participate in the
    // per-user supersession map here.
    const capability = this.registry.byId(input.capabilityId);
    if (!capability) {
      log.warn(
        { step: "resume-skipped", capabilityId: input.capabilityId, channelId: input.ctx.channelId },
        "capability not registered — cannot resume",
      );
      return { handled: false };
    }

    const ctx: CapabilityCtx = {
      ...input.ctx,
      // Synthetic input — `run()` does not consult `ctx.input`, but the type
      // requires the field. Mark it as a callback so any code that does peek
      // sees a non-text source.
      input: { kind: "callback", data: `resume:${input.capabilityId}` },
      emit: (artifact) => this.renderer.render(artifact, ctx),
    };

    log.info(
      { step: "resume-invoke", capabilityId: capability.id, channelId: ctx.channelId },
      "resuming capability",
    );
    let artifact;
    try {
      artifact = await capability.run(input.params as never, ctx);
    } catch (err) {
      log.error(
        { err, capabilityId: capability.id, channelId: ctx.channelId },
        "capability.run threw on resume",
      );
      throw err;
    }
    await this.renderer.render(artifact, ctx);
    log.info(
      { step: "capability-done", capabilityId: capability.id, kind: "resumed" },
      "resume complete",
    );
    return { handled: true };
  }
}
