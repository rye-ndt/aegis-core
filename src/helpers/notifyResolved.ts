import { Api, InlineKeyboard } from "grammy";
import type { SigningResolutionEvent } from "../use-cases/interface/input/signingRequest.interface";
import type { RecipientNotificationUseCase } from "../use-cases/implementations/recipientNotification.useCase";
import { CHAIN_CONFIG, getExplorerTxUrl } from "./chainConfig";
import { decodeErc20Transfer } from "./decodeErc20Transfer";
import { createLogger } from "./observability/logger";

const log = createLogger("notifyResolved");

/**
 * Builds the `onResolved` callback fed into `SigningRequestUseCaseImpl`. All
 * CLIs (telegram / http / worker) share the same recovery + success UX, so
 * the logic lives here.
 *
 * Branches:
 * - approved → friendly "you sent X TOKEN to 0x…" message + inline-keyboard
 *   "View on explorer" URL button when the chain has an explorer configured.
 *   Falls back to a plain "Transaction submitted" + button if calldata isn't
 *   a recognised ERC20 transfer (e.g. swap / yield deposit).
 * - rejected (no errorCode) → user explicitly rejected in the mini app.
 * - rejected + insufficient_token_balance + USDC → /buy nudge with inline
 *   keyboard whose callbacks (`buy:y:<amt>` / `buy:n:<amt>`) feed straight
 *   into the existing BuyCapability confirm step.
 * - rejected + any other errorCode → surface the FE's friendly message.
 */
export function buildNotifyResolved(
  tgApi: Api,
  chainId: number = CHAIN_CONFIG.chainId,
  recipientNotificationUseCase?: RecipientNotificationUseCase,
): (event: SigningResolutionEvent) => Promise<void> {
  return async (event: SigningResolutionEvent): Promise<void> => {
    const { chatId, txHash, rejected, errorCode, errorMessage, data } = event;

    if (!rejected) {
      await sendSuccessMessage(tgApi, chainId, chatId, txHash, data);

      if (event.recipientTelegramUserId && recipientNotificationUseCase) {
        try {
          await recipientNotificationUseCase.dispatchP2PSend({
            recipientTelegramUserId: event.recipientTelegramUserId,
            senderUserId: event.userId,
            senderChatId: String(event.chatId),
            senderDisplayName: null,
            senderHandle: null,
            tokenSymbol: event.tokenSymbol ?? "UNKNOWN",
            amountFormatted: event.amountFormatted ?? "",
            chainId,
            txHash: txHash ?? null,
          });
        } catch (err) {
          log.error({ err }, "recipient-notify-dispatch-failed");
        }
      }

      return;
    }

    if (errorCode === "insufficient_token_balance") {
      const decoded = decodeErc20Transfer(data, chainId);
      if (decoded?.isUsdc) {
        // Round up to integer so /buy's amount regex (and onramp providers)
        // accept it cleanly. Floor < 1 USDC up to 1 — nobody wants to onramp
        // sub-dollar amounts.
        const suggested = Math.max(
          1,
          Math.ceil(parseFloat(decoded.amountHuman)),
        );
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
          {
            step: "insufficient-balance-nudge",
            chatId,
            suggested,
            attempted: decoded.amountHuman,
          },
          "sent /buy nudge",
        );
        return;
      }
      // Non-USDC or failed decode: still tell the user *why*, but no /buy
      // nudge (the onramp only supports USDC).
      await tgApi.sendMessage(
        chatId,
        errorMessage ??
          "Your account does not have enough token balance to complete this transfer.",
      );
      return;
    }

    if (errorCode) {
      await tgApi.sendMessage(
        chatId,
        errorMessage ?? `Transaction failed (${errorCode}).`,
      );
      return;
    }

    await tgApi.sendMessage(chatId, "Transaction rejected in the app.");
  };
}

async function sendSuccessMessage(
  tgApi: Api,
  chainId: number,
  chatId: number,
  txHash: string | undefined,
  data: string | undefined,
): Promise<void> {
  const explorerUrl = txHash ? getExplorerTxUrl(chainId, txHash) : null;
  const keyboard = explorerUrl
    ? new InlineKeyboard().url("🔍 View on explorer", explorerUrl)
    : undefined;

  // Try to decode an ERC20 transfer for a friendly recap. Yields/swaps don't
  // contain a bare `transfer` selector so this returns null and we fall back
  // to a generic "transaction submitted" line — still with the explorer
  // button when available.
  const decoded = decodeErc20Transfer(data, chainId);
  let text: string;
  if (decoded) {
    const symbol = decoded.isUsdc
      ? "USDC"
      : shortenAddress(decoded.tokenAddress);
    const recipient = shortenAddress(decoded.recipient);
    text = [
      "*Transaction confirmed.*",
      "",
      `You sent *${decoded.amountHuman}* *${symbol}* to \`${recipient}\`.`,
    ].join("\n");
  } else if (txHash) {
    text = "Transaction submitted.";
  } else {
    // No txHash → likely a manual-path resolution that didn't carry one. Keep
    // the legacy fallback so we never go silent.
    text = "Transaction submitted.";
  }

  try {
    await tgApi.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    // Markdown can choke on rare hash characters or future symbol additions.
    // Retry plain so the user always gets *some* confirmation.
    log.warn(
      { err, chatId },
      "tx success message markdown send failed — retrying plain",
    );
    await tgApi.sendMessage(
      chatId,
      stripMarkdown(text),
      keyboard ? { reply_markup: keyboard } : {},
    );
  }
}

function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function stripMarkdown(s: string): string {
  return s.replace(/[*_`]/g, "");
}
