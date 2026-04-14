import type {
  IResolverEngine,
  ResolvedPayload,
} from "../../../../use-cases/interface/output/resolver.interface";
import { DisambiguationRequiredError } from "../../../../use-cases/interface/output/resolver.interface";
import type { ITokenRegistryService } from "../../../../use-cases/interface/output/tokenRegistry.interface";
import type { IUserProfileDB } from "../../../../use-cases/interface/output/repository/userProfile.repo";
import type { ITelegramHandleResolver } from "../../../../use-cases/interface/output/telegramResolver.interface";
import { TelegramHandleNotFoundError } from "../../../../use-cases/interface/output/telegramResolver.interface";
import type { IPrivyAuthService } from "../../../../use-cases/interface/output/privyAuth.interface";
import type { ITokenRecord } from "../../../../use-cases/interface/output/repository/tokenRegistry.repo";
import { RESOLVER_FIELD } from "../../../../helpers/enums/resolverField.enum";
import { toRaw } from "../../../../helpers/bigint";

export class ResolverEngineImpl implements IResolverEngine {
  constructor(
    private readonly tokenRegistry: ITokenRegistryService,
    private readonly userProfileDB: IUserProfileDB,
    private readonly telegramResolver?: ITelegramHandleResolver,
    private readonly privyAuthService?: IPrivyAuthService,
  ) {}

  async resolve(params: {
    resolverFields: Partial<Record<string, string>>;
    userId: string;
    chainId: number;
  }): Promise<ResolvedPayload> {
    const { resolverFields, userId, chainId } = params;

    // ── Sender address — always injected from the user's session profile ─────
    const profile = await this.userProfileDB.findByUserId(userId);
    const senderAddress = profile?.eoaAddress ?? null;

    // ── Token resolution ─────────────────────────────────────────────────────
    let fromToken: ITokenRecord | null = null;
    let toToken: ITokenRecord | null = null;

    const fromSymbol = resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL];
    const toSymbol = resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL];

    if (fromSymbol) {
      // After disambiguation the slot is patched to a 0x address — use exact
      // address lookup; otherwise do a symbol search that may need disambiguation.
      if (/^0x[0-9a-fA-F]{40}$/.test(fromSymbol)) {
        console.log(
          `[ResolverEngine] fromToken is a 0x address, resolving by address: ${fromSymbol}`,
        );
        fromToken = await this.resolveTokenByAddress(fromSymbol, chainId);
        if (!fromToken) {
          throw new Error(
            `Token address ${fromSymbol} not found in registry for chainId ${chainId}.`,
          );
        }
        console.log(
          `[ResolverEngine] fromToken resolved (address) → ${fromToken.symbol} (${fromToken.address})`,
        );
      } else {
        console.log(
          `[ResolverEngine] resolving fromToken symbol="${fromSymbol}" chainId=${chainId}`,
        );
        const candidates = await this.tokenRegistry.searchBySymbol(
          fromSymbol,
          chainId,
        );
        if (candidates.length === 0) {
          throw new Error(
            `Token not found: ${fromSymbol}. Make sure it is supported on this chain.`,
          );
        }
        if (candidates.length > 1) {
          throw new DisambiguationRequiredError("from", fromSymbol, candidates);
        }
        fromToken = candidates[0]!;
        console.log(
          `[ResolverEngine] fromToken resolved (symbol) → ${fromToken.symbol} (${fromToken.address})`,
        );
      }
    }

    if (toSymbol) {
      if (/^0x[0-9a-fA-F]{40}$/.test(toSymbol)) {
        console.log(
          `[ResolverEngine] toToken is a 0x address, resolving by address: ${toSymbol}`,
        );
        toToken = await this.resolveTokenByAddress(toSymbol, chainId);
        if (!toToken) {
          throw new Error(
            `Token address ${toSymbol} not found in registry for chainId ${chainId}.`,
          );
        }
        console.log(
          `[ResolverEngine] toToken resolved (address) → ${toToken.symbol} (${toToken.address})`,
        );
      } else {
        console.log(
          `[ResolverEngine] resolving toToken symbol="${toSymbol}" chainId=${chainId}`,
        );
        const candidates = await this.tokenRegistry.searchBySymbol(
          toSymbol,
          chainId,
        );
        if (candidates.length === 0) {
          throw new Error(
            `Token not found: ${toSymbol}. Make sure it is supported on this chain.`,
          );
        }
        if (candidates.length > 1) {
          throw new DisambiguationRequiredError("to", toSymbol, candidates);
        }
        toToken = candidates[0]!;
        console.log(
          `[ResolverEngine] toToken resolved (symbol) → ${toToken.symbol} (${toToken.address})`,
        );
      }
    }

    // ── Amount resolver ───────────────────────────────────────────────────────
    // Requires:  readableAmount  (e.g. "5", "0.25") from the LLM
    //            fromToken       already resolved above so decimals are known
    //
    // Converts human-readable amount → raw integer string using BigInt
    // arithmetic (no floating-point loss at any decimal precision).
    let rawAmount: string | null = null;
    const humanAmount = resolverFields[RESOLVER_FIELD.READABLE_AMOUNT];
    if (humanAmount && fromToken) {
      rawAmount = toRaw(humanAmount, fromToken.decimals);
      console.log(
        `[ResolverEngine] amount "${humanAmount}" → rawAmount="${rawAmount}" (decimals=${fromToken.decimals}, token=${fromToken.symbol})`,
      );
    } else if (humanAmount && !fromToken) {
      console.warn(
        `[ResolverEngine] readableAmount="${humanAmount}" provided but fromToken is null — rawAmount cannot be computed yet`,
      );
    }

    // ── User handle → EVM wallet ─────────────────────────────────────────────
    let recipientAddress: string | null = null;
    let recipientTelegramUserId: string | null = null;

    const handle = resolverFields[RESOLVER_FIELD.USER_HANDLE];
    if (handle) {
      if (!this.telegramResolver || !this.privyAuthService) {
        throw new Error(
          "Peer-to-peer transfers are not configured on this server.",
        );
      }

      console.log(`[ResolverEngine] resolving Telegram handle "@${handle}"`);
      let telegramUserId: string;
      try {
        telegramUserId = await this.telegramResolver.resolveHandle(handle);
        console.log(
          `[ResolverEngine] @${handle} → telegramUserId=${telegramUserId}`,
        );
      } catch (err) {
        if (err instanceof TelegramHandleNotFoundError) {
          throw new Error(
            `Could not find Telegram user @${handle}. Check the handle and try again.`,
          );
        }
        throw err;
      }

      recipientAddress =
        await this.privyAuthService.getOrCreateWalletByTelegramId(
          telegramUserId,
        );
      recipientTelegramUserId = telegramUserId;
      console.log(
        `[ResolverEngine] telegramUserId=${telegramUserId} → wallet=${recipientAddress}`,
      );
    }

    return {
      fromToken,
      toToken,
      rawAmount,
      recipientAddress,
      recipientTelegramUserId,
      senderAddress,
    };
  }

  async resolveTokenByAddress(
    address: string,
    chainId: number,
  ): Promise<ITokenRecord | null> {
    // Used by the disambiguation confirm path — look up by exact address.
    // searchBySymbol with the address string: the DB does ILIKE pattern matching,
    // so we filter the results for an exact address match.
    const lowerAddress = address.toLowerCase();
    const candidates = await this.tokenRegistry.searchBySymbol(address, chainId);
    return (
      candidates.find((r) => r.address.toLowerCase() === lowerAddress) ?? null
    );
  }
}
