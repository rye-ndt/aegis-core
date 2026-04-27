import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type {
  Artifact,
  CapabilityCtx,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IArtifactRenderer } from "../../../../use-cases/interface/output/artifactRenderer.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { SignRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import type { ISigningRequestUseCase } from "../../../../use-cases/interface/input/signingRequest.interface";
import type { SigningRequestRecord } from "../../../../use-cases/interface/output/cache/signingRequest.cache";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("telegramArtifactRenderer");
const MINI_APP_URL = process.env.MINI_APP_URL;
const SIGN_REQUEST_TTL_SECONDS = 600;
const STATUS_TICK_MS = 400;
const STATUS_MAX_DOTS = 3;

interface StatusEntry {
  messageId: number;
  chatId: number;
  baseText: string;
  interval: NodeJS.Timeout;
}

/**
 * Single exhaustive switch that replaces the scattered `sendMiniAppPrompt`,
 * `sendMiniAppButton`, `sendApproveButton`, and bare `ctx.reply` calls that
 * used to live across telegram/handler.ts.
 */
export class TelegramArtifactRenderer implements IArtifactRenderer {
  /**
   * Active animated "status" messages keyed by `${chatId}:${id}`. Each entry
   * owns a setInterval handle that edits the Telegram message in-place until
   * a matching `chat_status_stop` clears the timer.
   */
  private readonly statusMessages = new Map<string, StatusEntry>();

  constructor(
    private readonly bot: Bot,
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
    private readonly signingRequestUseCase?: ISigningRequestUseCase,
  ) {}

  async render(artifact: Artifact, ctx: CapabilityCtx): Promise<void> {
    const chatId = Number(ctx.channelId);
    switch (artifact.kind) {
      case "noop":
        return;
      case "chat":
        await this.sendChat(chatId, artifact.text, artifact.keyboard, artifact.parseMode);
        return;
      case "chat_status_start":
        await this.startStatus(chatId, artifact.id, artifact.text);
        return;
      case "chat_status_stop":
        this.stopStatus(chatId, artifact.id);
        return;
      case "mini_app":
        await this.sendMiniApp(
          chatId,
          artifact.promptText,
          artifact.buttonText,
          artifact.fallbackText,
          artifact.request.requestId,
          async () => {
            if (this.miniAppRequestCache) {
              await this.miniAppRequestCache.store(artifact.request);
            }
          },
        );
        return;
      case "sign_calldata": {
        const now = newCurrentUTCEpoch();
        const requestId = newUuid();
        const expiresAt = now + SIGN_REQUEST_TTL_SECONDS;
        const signRequest: SignRequest = {
          requestId,
          requestType: "sign",
          userId: ctx.userId,
          to: artifact.to,
          value: artifact.value,
          data: artifact.data,
          description: artifact.description,
          autoSign: artifact.autoSign,
          createdAt: now,
          expiresAt,
        };
        const buttonText = artifact.autoSign ? "Execute Automatically" : "Open Aegis to Sign";
        const promptText = artifact.autoSign
          ? "Tap below to execute silently."
          : "Tap below to review and sign.";
        await this.sendMiniApp(
          chatId,
          promptText,
          buttonText,
          undefined,
          requestId,
          async () => {
            // Persist BOTH caches before the FE can hit POST /response.
            // miniAppRequestCache alone leaves the FE able to fetch the
            // request, but resolveRequest 404s on signingRequestCache miss
            // and the cleanup at httpServer.handleSignMiniAppResponse never
            // runs — leading to an infinite poll loop on the FE side.
            // Mirrors swapCapability's two-cache write at line 182-209.
            if (this.signingRequestUseCase) {
              const record: SigningRequestRecord = {
                id: requestId,
                userId: ctx.userId,
                chatId,
                to: artifact.to,
                value: artifact.value,
                data: artifact.data,
                description: artifact.description,
                status: "pending",
                createdAt: now,
                expiresAt,
                autoSign: artifact.autoSign,
              };
              await this.signingRequestUseCase.create(record);
            }
            if (this.miniAppRequestCache) {
              await this.miniAppRequestCache.store(signRequest);
            }
          },
        );
        return;
      }
      case "llm_data":
        // Free-text assistant reply. LLM data in the Telegram surface is
        // rendered as a plain chat message.
        await this.sendChat(chatId, String(artifact.data), undefined, "Markdown");
        return;
    }
  }

  private async sendChat(
    chatId: number,
    text: string,
    keyboard?: InlineKeyboard,
    parseMode?: "Markdown",
  ): Promise<void> {
    const opts: Record<string, unknown> = {};
    if (keyboard) opts.reply_markup = keyboard;
    if (parseMode) opts.parse_mode = parseMode;
    try {
      await this.bot.api.sendMessage(chatId, text, opts);
    } catch {
      // Retry without parse_mode if markdown parsing failed.
      const fallbackOpts: Record<string, unknown> = {};
      if (keyboard) fallbackOpts.reply_markup = keyboard;
      await this.bot.api.sendMessage(chatId, text, fallbackOpts);
    }
  }

  private async startStatus(chatId: number, id: string, baseText: string): Promise<void> {
    const key = `${chatId}:${id}`;
    if (this.statusMessages.has(key)) {
      // A prior start with the same id is still active. Be defensive: stop
      // it before starting a fresh one so we don't leak intervals.
      this.stopStatus(chatId, id);
    }
    // Send the initial frame at 1 dot, then cycle 1→2→3→1 on the interval.
    // The first edit fires after STATUS_TICK_MS, so a fast resolution may
    // never see an edit — that's expected and harmless: the user sees the
    // "Finding your receiver." line either way, and the rest of the flow
    // continues silently.
    let dots = 1;
    const initial = `${baseText}${".".repeat(dots)}`;
    let messageId: number;
    try {
      const sent = await this.bot.api.sendMessage(chatId, initial);
      messageId = sent.message_id;
    } catch (err) {
      log.error({ err, chatId, id }, "status-start send failed");
      return;
    }
    const interval = setInterval(() => {
      dots = (dots % STATUS_MAX_DOTS) + 1;
      const text = `${baseText}${".".repeat(dots)}`;
      this.bot.api
        .editMessageText(chatId, messageId, text)
        .catch((err: unknown) => {
          // Telegram 400 "message is not modified" / 429 rate-limit are
          // expected occasionally — the next tick will recover.
          log.debug({ err, chatId, id }, "status-tick edit failed");
        });
    }, STATUS_TICK_MS);
    this.statusMessages.set(key, { messageId, chatId, baseText, interval });
  }

  private stopStatus(chatId: number, id: string): void {
    const key = `${chatId}:${id}`;
    const entry = this.statusMessages.get(key);
    if (!entry) return;
    clearInterval(entry.interval);
    this.statusMessages.delete(key);
  }

  private async sendMiniApp(
    chatId: number,
    promptText: string,
    buttonText: string,
    fallbackText: string | undefined,
    _requestId: string,
    store: () => Promise<void>,
  ): Promise<void> {
    if (!MINI_APP_URL) {
      if (fallbackText) await this.bot.api.sendMessage(chatId, fallbackText);
      return;
    }
    await store();
    const url = `${MINI_APP_URL}?requestId=${_requestId}`;
    const reply_markup = new InlineKeyboard().webApp(buttonText, url);
    await this.bot.api.sendMessage(chatId, promptText, { reply_markup });
  }
}
