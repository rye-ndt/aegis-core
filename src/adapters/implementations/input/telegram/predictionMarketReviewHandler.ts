import type { Api, Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { newCurrentUTCEpoch } from "../../../../helpers/time/dateTime";
import { createLogger } from "../../../../helpers/observability/logger";
import type { ReviewNotifier } from "../../../../use-cases/implementations/predictionMarketExtractFacts.usecase";
import type { IPredictionMarketFactRepository } from "../../../../use-cases/interface/predictionMarket/IPredictionMarketFactRepository";

const log = createLogger("predictionMarketReviewHandler");

const CALLBACK_PREFIX = "pm_review";

export const PM_REVIEW_CALLBACK_PREFIX = `${CALLBACK_PREFIX}:`;

export class PredictionMarketReviewHandler {
  constructor(
    private readonly facts: IPredictionMarketFactRepository,
    private readonly adminChatId: string,
  ) {}

  /** Register the three `pm_review:*` callback handlers on the shared bot. */
  register(bot: Bot): void {
    if (!this.adminChatId) return;
    bot.callbackQuery(/^pm_review:(approve|reject|edit):.+/, async (ctx) => {
      try {
        if (String(ctx.chat?.id ?? "") !== this.adminChatId) {
          await ctx.answerCallbackQuery({ text: "Not authorized." });
          return;
        }
        const data = ctx.callbackQuery.data ?? "";
        const parts = data.split(":");
        const action = parts[1];
        const reviewId = parts.slice(2).join(":");
        if (!action || !reviewId) {
          await ctx.answerCallbackQuery({ text: "Malformed callback." });
          return;
        }
        const review = await this.facts.getReview(reviewId);
        if (!review || review.status !== "pending") {
          await ctx.answerCallbackQuery({ text: "Review already resolved." });
          return;
        }
        const resolvedByChatId = String(ctx.chat?.id ?? null);
        if (action === "approve") {
          await this.facts.upsertFact({
            ...review.proposedFact,
            regexVerified: true,
          });
          await this.facts.resolveReview(reviewId, {
            status: "approved",
            resolvedAtEpoch: newCurrentUTCEpoch(),
            resolvedByChatId,
          });
          log.info(
            { step: "review-resolved", reviewId, marketId: review.marketId, outcome: "approved" },
            "review",
          );
          await ctx.answerCallbackQuery({ text: "Approved." });
          await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
        } else if (action === "reject") {
          await this.facts.resolveReview(reviewId, {
            status: "rejected",
            resolvedAtEpoch: newCurrentUTCEpoch(),
            resolvedByChatId,
          });
          log.info(
            { step: "review-resolved", reviewId, marketId: review.marketId, outcome: "rejected" },
            "review",
          );
          await ctx.answerCallbackQuery({ text: "Rejected." });
          await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
        } else {
          // 'edit' flow not yet implemented; tell the operator to fix the DB
          // row directly or approve/reject.
          await ctx.answerCallbackQuery({
            text: "Edit not implemented — approve/reject, or fix the row directly.",
          });
        }
      } catch (err) {
        log.error({ err }, "review-handler-failed");
        try {
          await ctx.answerCallbackQuery({ text: "Internal error." });
        } catch {
          /* ignore */
        }
      }
    });
  }

  /**
   * Returns a `ReviewNotifier` bound to the supplied bot API + admin chat.
   * The notifier is given to the extract-facts use case; calling it posts a
   * formatted approve/edit/reject prompt to the admin chat.
   */
  notifier(tgApi: Api): ReviewNotifier {
    return async ({ reqId, reviewId, market, proposedFactSummary, failureSummary }) => {
      if (!this.adminChatId) return;
      const text =
        `🟡 Extraction needs review\n` +
        `Market: ${market.question}\n` +
        `Proposed: ${proposedFactSummary}\n` +
        `Failed: ${failureSummary}`;
      const kb = new InlineKeyboard()
        .text("Approve", `${PM_REVIEW_CALLBACK_PREFIX}approve:${reviewId}`)
        .text("Edit", `${PM_REVIEW_CALLBACK_PREFIX}edit:${reviewId}`)
        .text("Reject", `${PM_REVIEW_CALLBACK_PREFIX}reject:${reviewId}`);
      try {
        await tgApi.sendMessage(this.adminChatId, text, { reply_markup: kb });
        log.info({ step: "review-notify-sent", reqId, reviewId, marketId: market.marketId }, "review");
      } catch (err) {
        log.warn({ err, reqId, reviewId, marketId: market.marketId }, "review-notify-send-failed");
      }
    };
  }
}
