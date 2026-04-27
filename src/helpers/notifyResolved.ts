import { Api, InlineKeyboard } from "grammy";
import { createLogger } from "./observability/logger";
import { decodeFailedTransfer } from "./decodeFailedTransfer";
import type { SigningResolutionEvent } from "../use-cases/interface/input/signingRequest.interface";

const log = createLogger("notifyResolved");

/**
 * Builds the `onResolved` callback fed into `SigningRequestUseCaseImpl`. All
 * CLIs (telegram / http / worker) share the same recovery UX, so the logic
 * lives here.
 *
 * Branches:
 * - approved → "Transaction submitted" with tx hash.
 * - rejected (no errorCode) → user explicitly rejected in the mini app.
 * - rejected + insufficient_token_balance + USDC → /buy nudge with inline
 *   keyboard whose callbacks (`buy:y:<amt>` / `buy:n:<amt>`) feed straight
 *   into the existing BuyCapability confirm step.
 * - rejected + any other errorCode → surface the FE's friendly message.
 */
export function buildNotifyResolved(tgApi: Api): (event: SigningResolutionEvent) => Promise<void> {
  return async (event: SigningResolutionEvent): Promise<void> => {
    const { chatId, txHash, rejected, errorCode, errorMessage, data } = event;

    if (!rejected) {
      await tgApi.sendMessage(
        chatId,
        `Transaction submitted.\nTx hash: \`${txHash ?? "unknown"}\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (errorCode === "insufficient_token_balance") {
      const decoded = decodeFailedTransfer(data);
      if (decoded?.isUsdc) {
        // Round up to integer so /buy's amount regex (and onramp providers)
        // accept it cleanly. Floor < 1 USDC up to 1 — nobody wants to onramp
        // sub-dollar amounts.
        const suggested = Math.max(1, Math.ceil(parseFloat(decoded.amountHuman)));
        const keyboard = new InlineKeyboard()
          .text("Yes, deposit", `buy:y:${suggested}`)
          .text("No, buy with card", `buy:n:${suggested}`);
        await tgApi.sendMessage(
          chatId,
          [
            "⚠️ *Not enough USDC to send.*",
            "",
            `You tried to send *${decoded.amountHuman} USDC* but your balance is too low.`,
            "",
            `Want to top up *${suggested} USDC*?`,
            "",
            "Already have crypto in another wallet, or prefer card?",
          ].join("\n"),
          { parse_mode: "Markdown", reply_markup: keyboard },
        );
        log.info(
          { step: "insufficient-balance-nudge", chatId, suggested, attempted: decoded.amountHuman },
          "sent /buy nudge",
        );
        return;
      }
      // Non-USDC or failed decode: still tell the user *why*, but no /buy
      // nudge (the onramp only supports USDC).
      await tgApi.sendMessage(
        chatId,
        errorMessage ?? "Your account does not have enough token balance to complete this transfer.",
      );
      return;
    }

    if (errorCode) {
      await tgApi.sendMessage(chatId, errorMessage ?? `Transaction failed (${errorCode}).`);
      return;
    }

    await tgApi.sendMessage(chatId, "Transaction rejected in the app.");
  };
}
