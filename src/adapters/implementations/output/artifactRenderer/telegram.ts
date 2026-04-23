import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type {
  Artifact,
  CapabilityCtx,
} from "../../../../use-cases/interface/input/capability.interface";
import type { IArtifactRenderer } from "../../../../use-cases/interface/output/artifactRenderer.interface";
import type { IMiniAppRequestCache } from "../../../../use-cases/interface/output/cache/miniAppRequest.cache";
import type { SignRequest } from "../../../../use-cases/interface/output/cache/miniAppRequest.types";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { newUuid } from "../../../../helpers/uuid";

const MINI_APP_URL = process.env.MINI_APP_URL;
const SIGN_REQUEST_TTL_SECONDS = 600;

/**
 * Single exhaustive switch that replaces the scattered `sendMiniAppPrompt`,
 * `sendMiniAppButton`, `sendApproveButton`, and bare `ctx.reply` calls that
 * used to live across telegram/handler.ts.
 */
export class TelegramArtifactRenderer implements IArtifactRenderer {
  constructor(
    private readonly bot: Bot,
    private readonly miniAppRequestCache?: IMiniAppRequestCache,
  ) {}

  async render(artifact: Artifact, ctx: CapabilityCtx): Promise<void> {
    const chatId = Number(ctx.channelId);
    switch (artifact.kind) {
      case "noop":
        return;
      case "chat":
        await this.sendChat(chatId, artifact.text, artifact.keyboard, artifact.parseMode);
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
        const signRequest: SignRequest = {
          requestId: newUuid(),
          requestType: "sign",
          userId: ctx.userId,
          to: artifact.to,
          value: artifact.value,
          data: artifact.data,
          description: artifact.description,
          autoSign: artifact.autoSign,
          createdAt: newCurrentUTCEpoch(),
          expiresAt: newCurrentUTCEpoch() + SIGN_REQUEST_TTL_SECONDS,
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
          signRequest.requestId,
          async () => {
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
