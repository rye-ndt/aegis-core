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

    const fromSymbol = resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL];
    const toSymbol = resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL];

    const fromToken = await this.resolveTokenField("from", fromSymbol, chainId);
    const toToken = await this.resolveTokenField("to", toSymbol, chainId);

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
    const record = await this.tokenRegistry.findByAddressAndChain(address, chainId);
    return record ?? null;
  }

  private async resolveTokenField(
    slot: "from" | "to",
    symbol: string | undefined,
    chainId: number,
  ): Promise<ITokenRecord | null> {
    if (!symbol) return null;
    const label = `${slot}Token`;

    if (/^0x[0-9a-fA-F]{40}$/.test(symbol)) {
      console.log(`[ResolverEngine] ${label} is a 0x address, resolving by address: ${symbol}`);
      const token = await this.resolveTokenByAddress(symbol, chainId);
      if (!token) {
        throw new Error(
          `Token address ${symbol} not found in registry for chainId ${chainId}.`,
        );
      }
      console.log(`[ResolverEngine] ${label} resolved (address) → ${token.symbol} (${token.address})`);
      return token;
    }

    console.log(`[ResolverEngine] resolving ${label} symbol="${symbol}" chainId=${chainId}`);
    const candidates = await this.tokenRegistry.searchBySymbol(symbol, chainId);
    if (candidates.length === 0) {
      throw new Error(
        `Token not found: ${symbol}. Make sure it is supported on this chain.`,
      );
    }
    if (candidates.length > 1) {
      throw new DisambiguationRequiredError(slot, symbol, candidates);
    }
    const token = candidates[0]!;
    console.log(`[ResolverEngine] ${label} resolved (symbol) → ${token.symbol} (${token.address})`);
    return token;
  }
}
