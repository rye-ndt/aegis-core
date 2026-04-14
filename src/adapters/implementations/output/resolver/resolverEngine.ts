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
        `[ResolverEngine] fromToken resolved → ${fromToken.symbol} (${fromToken.address})`,
      );
    }

    if (toSymbol) {
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
        `[ResolverEngine] toToken resolved → ${toToken.symbol} (${toToken.address})`,
      );
    }

    // ── Amount resolution — requires fromToken decimals ──────────────────────
    let rawAmount: string | null = null;
    const humanAmount = resolverFields[RESOLVER_FIELD.READABLE_AMOUNT];
    if (humanAmount && fromToken) {
      rawAmount = toRaw(humanAmount, fromToken.decimals);
      console.log(
        `[ResolverEngine] amount "${humanAmount}" → rawAmount="${rawAmount}" (${fromToken.decimals} decimals)`,
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
