import { Bot } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { createLogger } from "../../../../helpers/observability/logger";
import type { TelegramAssistantHandler } from "./handler";

const log = createLogger("telegramBot");

/**
 * Wraps a grammY `Bot` with `@grammyjs/runner` so updates dispatch
 * concurrently. Plain `bot.start()` long-polls sequentially: the next update
 * isn't delivered to middleware until the prior handler's promise resolves.
 * That froze the bot whenever a capability awaited `signingRequest.waitFor`
 * (multi-step yield/swap) — grammy held the next user message behind a
 * 10-minute timeout. The runner runs middleware concurrently; the
 * dispatcher's per-user supersession (see `capabilityDispatcher.usecase.ts`)
 * handles ordering: abort prior, cancel pending signing, run new dispatch.
 */
export class TelegramBot {
  private runner: RunnerHandle | null = null;

  constructor(private bot: Bot, handler: TelegramAssistantHandler) {
    handler.register(this.bot);
  }

  start(): void {
    this.runner = run(this.bot);
    log.info({ step: "started", mode: "runner" }, "telegram bot started");
  }

  async stop(): Promise<void> {
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }
    await this.bot.stop();
  }
}
