import { Api } from "grammy";
import type { SigningResolutionEvent } from "../use-cases/interface/input/signingRequest.interface";
import type { RecipientNotificationUseCase } from "../use-cases/implementations/recipientNotification.useCase";
import type { IUserDB } from "../use-cases/interface/output/repository/user.repo";
import { CHAIN_CONFIG } from "./chainConfig";
import { decodeErc20Transfer } from "./decodeErc20Transfer";
import { createLogger } from "./observability/logger";
import { renderResultCard } from "../adapters/implementations/output/artifactRenderer/resultCard.render";
import type {
  IntentResult,
  IntentVerb,
} from "../use-cases/interface/input/resultCard.types";

const log = createLogger("notifyResolved");

/**
 * Builds the `onResolved` callback fed into `SigningRequestUseCaseImpl`. All
 * CLIs (telegram / http / worker) share the same recovery + success UX, so
 * the logic lives here.
 *
 * Branches:
 * - approved → result-card "you sent X TOKEN to 0x…" success card with the
 *   explorer button auto-derived from `txHashes`. Falls back to a generic
 *   "Transaction confirmed" card when calldata isn't a recognised ERC20
 *   transfer (swaps / yield deposits).
 * - rejected (no errorCode) → user explicitly rejected in the mini app.
 * - rejected + insufficient_token_balance + USDC → /buy nudge as
 *   `nextActions` whose callbacks (`buy:y:<amt>` / `buy:n:<amt>`) feed
 *   straight into the existing BuyCapability confirm step. The callback
 *   payloads are part of the buy-flow contract and MUST stay byte-identical.
 * - rejected + any other errorCode → surface the FE's friendly message via
 *   a `failed` result-card.
 *
 * The render path goes through `renderResultCard` so the same MarkdownV2
 * formatting / spoiler / explorer-button rules apply that the rest of the
 * result-card framework uses.
 */
export function buildNotifyResolved(
  tgApi: Api,
  chainId: number = CHAIN_CONFIG.chainId,
  recipientNotificationUseCase?: RecipientNotificationUseCase,
  userRepo?: IUserDB,
): (event: SigningResolutionEvent) => Promise<void> {
  return async (event: SigningResolutionEvent): Promise<void> => {
    const { chatId, txHash, rejected, errorCode, errorMessage, data, planKind } = event;
    const start = Date.now();
    log.info(
      { step: "started", chatId, userId: event.userId, rejected, errorCode, hasTxHash: !!txHash, planKind },
      "notify-resolved",
    );

    if (!rejected) {
      const result =
        planKind === "recovery"
          ? buildRecoverySuccessResult(chainId, txHash)
          : buildSuccessResult(chainId, txHash, data);

      try {
        await sendCard(tgApi, chatId, result);
        log.info(
          {
            step: "succeeded",
            mode: planKind === "recovery" ? "recovery" : "default",
            chatId,
            hash: txHash,
            durationMs: Date.now() - start,
          },
          "notify-resolved",
        );
      } catch (err) {
        log.error(
          { step: "failed", err, chatId, durationMs: Date.now() - start },
          "notify-resolved",
        );
        throw err;
      }

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
        const result: IntentResult = {
          status: "failed",
          verb: "send",
          headline: "Not enough USDC to send",
          fields: [
            {
              label: "You tried to send",
              value: `${decoded.amountHuman} USDC`,
              emphasis: "primary",
            },
            { label: "Suggested top-up", value: `${suggested} USDC` },
          ],
          nextActions: [
            { label: "Yes, deposit", kind: "callback", payload: `buy:y:${suggested}` },
            { label: "No, buy with card", kind: "callback", payload: `buy:n:${suggested}` },
          ],
          complexity: "simple",
        };
        await sendCard(tgApi, chatId, result);
        log.info(
          {
            step: "succeeded",
            mode: "insufficient-balance-nudge",
            chatId,
            suggested,
            attempted: decoded.amountHuman,
            durationMs: Date.now() - start,
          },
          "notify-resolved",
        );
        return;
      }
      const result: IntentResult = {
        status: "failed",
        verb: "send",
        headline: "Not enough balance to send",
        fields: [
          {
            label: "Reason",
            value:
              errorMessage ??
              "Your account does not have enough token balance to complete this transfer.",
          },
        ],
        complexity: "simple",
      };
      await sendCard(tgApi, chatId, result);
      log.info(
        { step: "succeeded", mode: "non-usdc-insufficient-balance", chatId, durationMs: Date.now() - start },
        "notify-resolved",
      );
      return;
    }

    // Lockstep with FE `interpretSignError.ts` (Aster stock-trading codes).
    const stockMessage = stockErrorMessage(errorCode);
    if (stockMessage) {
      const result: IntentResult = {
        status: "failed",
        verb: "stock_buy",
        headline: "Stock action failed",
        fields: [{ label: "Reason", value: stockMessage }],
        complexity: "simple",
      };
      await sendCard(tgApi, chatId, result);
      log.info(
        { step: "succeeded", mode: "stock-error", chatId, errorCode, durationMs: Date.now() - start },
        "notify-resolved",
      );
      return;
    }

    if (errorCode) {
      const result: IntentResult = {
        status: "failed",
        verb: rejectionVerb(planKind),
        headline: "Transaction failed",
        fields: [
          {
            label: "Reason",
            value: errorMessage ?? `Transaction failed (${errorCode}).`,
          },
        ],
        complexity: "simple",
      };
      await sendCard(tgApi, chatId, result);
      log.info(
        { step: "succeeded", mode: "generic-error", chatId, errorCode, durationMs: Date.now() - start },
        "notify-resolved",
      );
      return;
    }

    const rejectedResult: IntentResult = {
      status: "failed",
      verb: rejectionVerb(planKind),
      headline: "Transaction rejected",
      fields: [{ label: "Reason", value: "Rejected in the Aegis app." }],
      complexity: "simple",
    };
    await sendCard(tgApi, chatId, rejectedResult);
    log.info(
      { step: "succeeded", mode: "user-rejected", chatId, durationMs: Date.now() - start },
      "notify-resolved",
    );
  };
}

function rejectionVerb(
  planKind: SigningResolutionEvent["planKind"],
): IntentVerb {
  if (planKind === "recovery") return "stock_buy";
  return "send";
}

function buildSuccessResult(
  chainId: number,
  txHash: string | undefined,
  data: string | undefined,
): IntentResult {
  const decoded = decodeErc20Transfer(data, chainId);
  if (decoded) {
    const symbol = decoded.isUsdc ? "USDC" : shortenAddress(decoded.tokenAddress);
    return {
      status: "success",
      verb: "send",
      headline: `You sent ${decoded.amountHuman} ${symbol}`,
      fields: [
        { label: "Amount", value: `${decoded.amountHuman} ${symbol}`, emphasis: "primary" },
        { label: "To", value: shortenAddress(decoded.recipient) },
      ],
      txHashes: txHash ? [{ hash: txHash, chainId }] : undefined,
      complexity: "simple",
    };
  }
  return {
    status: "success",
    verb: "send",
    headline: "Transaction confirmed",
    fields: [{ label: "Status", value: "Submitted" }],
    txHashes: txHash ? [{ hash: txHash, chainId }] : undefined,
    complexity: "simple",
  };
}

function buildRecoverySuccessResult(
  chainId: number,
  txHash: string | undefined,
): IntentResult {
  return {
    status: "success",
    verb: "stock_buy",
    headline: "Funds returned",
    fields: [
      { label: "Status", value: "Your collateral was bridged back to your home chain." },
    ],
    txHashes: txHash ? [{ hash: txHash, chainId }] : undefined,
    complexity: "simple",
  };
}

async function sendCard(
  tgApi: Api,
  chatId: number,
  result: IntentResult,
): Promise<void> {
  const rendered = renderResultCard({ result });
  try {
    await tgApi.sendMessage(chatId, rendered.text, {
      parse_mode: rendered.parseMode,
      ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
    });
  } catch (err) {
    log.warn({ err, chatId, verb: result.verb }, "result-card markdownV2 send failed — retrying plain");
    const plain =
      `${result.headline}\n` +
      result.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
    await tgApi.sendMessage(chatId, plain, {
      ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
    });
  }
}

/**
 * Maps Aster stock-trading errorCodes to user-facing messages. Lockstep
 * contract with FE `interpretSignError.ts` — add new codes here in the same
 * PR that introduces them on the FE.
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

