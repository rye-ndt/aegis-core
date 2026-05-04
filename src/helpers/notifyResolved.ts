import { Api, InlineKeyboard } from "grammy";
import type { SigningResolutionEvent } from "../use-cases/interface/input/signingRequest.interface";
import type { RecipientNotificationUseCase } from "../use-cases/implementations/recipientNotification.useCase";
import type { IUserDB } from "../use-cases/interface/output/repository/user.repo";
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
  userRepo?: IUserDB,
): (event: SigningResolutionEvent) => Promise<void> {
  return async (event: SigningResolutionEvent): Promise<void> => {
    const { chatId, txHash, rejected, errorCode, errorMessage, data, planKind } = event;

    if (!rejected) {
      if (planKind === "recovery") {
        await sendRecoverySuccessMessage(tgApi, chainId, chatId, txHash);
        log.info(
          { step: "recovery-success", chatId, hash: txHash },
          "stock recovery resolved",
        );
        return;
      }
      await sendSuccessMessage(tgApi, chainId, chatId, txHash, data);

      if (event.recipientTelegramUserId && recipientNotificationUseCase) {
        let senderDisplayName: string | null = null;
        if (userRepo) {
          try {
            const sender = await userRepo.findById(event.userId);
            senderDisplayName = sender?.userName ?? null;
          } catch (err) {
            log.warn({ err, userId: event.userId }, "sender-lookup-failed");
          }
        }
        try {
          await recipientNotificationUseCase.dispatchP2PSend({
            recipientTelegramUserId: event.recipientTelegramUserId,
            senderUserId: event.userId,
            senderChatId: String(event.chatId),
            senderDisplayName,
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

    // Lockstep with FE `interpretSignError.ts` (Aster stock-trading codes).
    // Add new codes here in the same PR that introduces them on the FE — the
    // string is the contract.
    const stockMessage = stockErrorMessage(errorCode);
    if (stockMessage) {
      await tgApi.sendMessage(chatId, stockMessage);
      log.info(
        { step: "stock-error", chatId, errorCode },
        "stock-specific failure surfaced",
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

async function sendRecoverySuccessMessage(
  tgApi: Api,
  chainId: number,
  chatId: number,
  txHash: string | undefined,
): Promise<void> {
  const explorerUrl = txHash ? getExplorerTxUrl(chainId, txHash) : null;
  const keyboard = explorerUrl
    ? new InlineKeyboard().url("🔍 View on explorer", explorerUrl)
    : undefined;
  const text = [
    "*Funds returned.*",
    "",
    "Your collateral was bridged back to your home chain.",
  ].join("\n");
  try {
    await tgApi.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    log.warn({ err, chatId }, "recovery success markdown send failed — retrying plain");
    await tgApi.sendMessage(
      chatId,
      stripMarkdown(text),
      keyboard ? { reply_markup: keyboard } : {},
    );
  }
}

/**
 * Maps Aster stock-trading errorCodes to user-facing chat messages. These
 * codes are the lockstep contract with FE `interpretSignError.ts` (Phase 2
 * impl plan P2.5b). Returns null when the code is not a stock code so the
 * caller falls through to its existing branch.
 */
function stockErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case "aster_pair_inactive":
      return "This stock pair is not currently tradable. Try a different symbol.";
    case "aster_min_size":
      return "Trade size is below the minimum. Try a larger amount.";
    case "aster_max_position":
      return "You've hit the per-user position limit for this asset.";
    case "aster_oracle_stale":
      return "The stock price oracle is stale. Please try again in a moment.";
    case "aster_insufficient_collateral":
      // Recovery is triggered by the capability layer when the failure
      // happens mid-flight (post-bridge); here we can only acknowledge the
      // code in case it surfaces standalone.
      return "Not enough collateral landed on BSC to open the position. Funds will be returned to your home chain.";
    case "stock_recovery_failed":
      return "Recovery failed — please contact support so we can manually return your funds.";
    default:
      return null;
  }
}

function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function stripMarkdown(s: string): string {
  return s.replace(/[*_`]/g, "");
}
