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
import { createLogger } from "../../../../helpers/observability/logger";

const log = createLogger("resolverEngine");

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

    const profile = await this.userProfileDB.findByUserId(userId);
    const senderAddress = profile?.eoaAddress ?? null;

    const fromSymbol = resolverFields[RESOLVER_FIELD.FROM_TOKEN_SYMBOL];
    const toSymbol = resolverFields[RESOLVER_FIELD.TO_TOKEN_SYMBOL];

    const fromToken = await this.resolveTokenField("from", fromSymbol, chainId);
    const toToken = await this.resolveTokenField("to", toSymbol, chainId);

    let rawAmount: string | null = null;
    const humanAmount = resolverFields[RESOLVER_FIELD.READABLE_AMOUNT];
    if (humanAmount && fromToken) {
      rawAmount = toRaw(humanAmount, fromToken.decimals);
      log.info(
        { step: "amount-resolved", humanAmount, rawAmount, decimals: fromToken.decimals, token: fromToken.symbol },
        "amount converted",
      );
    } else if (humanAmount && !fromToken) {
      log.warn(
        { reason: "fromToken-missing", humanAmount },
        "readableAmount provided but fromToken is null — rawAmount cannot be computed yet",
      );
    }

    let recipientAddress: string | null = null;
    let recipientTelegramUserId: string | null = null;

    const handle = resolverFields[RESOLVER_FIELD.USER_HANDLE];
    if (handle) {
      if (!this.telegramResolver || !this.privyAuthService) {
        throw new Error(
          "Peer-to-peer transfers are not configured on this server.",
        );
      }

      log.debug({ choice: "telegram-handle", handle }, "resolving Telegram handle");
      let telegramUserId: string;
      try {
        telegramUserId = await this.telegramResolver.resolveHandle(handle);
        log.info({ step: "handle-resolved", handle, telegramUserId }, "Telegram handle resolved");
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
      log.info({ step: "wallet-resolved", telegramUserId, wallet: recipientAddress }, "wallet resolved from Telegram handle");
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
      log.debug({ choice: "address", label, symbol }, "resolving token by address");
      const token = await this.resolveTokenByAddress(symbol, chainId);
      if (!token) {
        throw new Error(
          `Token address ${symbol} not found in registry for chainId ${chainId}.`,
        );
      }
      log.debug({ label, symbol: token.symbol, address: token.address }, "token resolved by address");
      return token;
    }

    log.debug({ choice: "symbol", label, symbol, chainId }, "resolving token by symbol");
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
    log.debug({ label, symbol: token.symbol, address: token.address }, "token resolved by symbol");
    return token;
  }
}
