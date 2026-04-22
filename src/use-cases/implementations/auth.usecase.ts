import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { USER_STATUSES } from "../../helpers/enums/statuses.enum";
import type { IUserDB } from "../interface/output/repository/user.repo";
import type {
  IAuthUseCase,
  IPrivyLoginInput,
} from "../interface/input/auth.interface";
import type { IPrivyAuthService } from "../interface/output/privyAuth.interface";
import type { IUser } from "../interface/output/repository/user.repo";
import type { ITelegramSessionDB } from "../interface/output/repository/telegramSession.repo";
import type { ITelegramNotifier } from "../interface/output/telegramNotifier.interface";
import type { IUserProfileCache } from "../interface/output/cache/userProfile.cache";
import type { ITokenDelegationDB } from "../interface/output/repository/tokenDelegation.repo";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export class AuthUseCaseImpl implements IAuthUseCase {
  private static readonly WELCOME_BACK_TEXT =
    "You're now signed in to Aegis!\n\nYou can:\n• Describe a trade — the agent will parse and execute it\n• Send /new to start a fresh conversation\n• Send /history to see recent messages\n• Send /logout to sign out";

  constructor(
    private readonly userDB: IUserDB,
    private readonly privyAuthService?: IPrivyAuthService,
    private readonly telegramSessionDB?: ITelegramSessionDB,
    private readonly telegramNotifier?: ITelegramNotifier,
    private readonly userProfileCache?: IUserProfileCache,
    private readonly tokenDelegationDB?: ITokenDelegationDB,
  ) {}

  async loginWithPrivy(input: IPrivyLoginInput): Promise<{ expiresAtEpoch: number; userId: string }> {
    if (!this.privyAuthService) throw new Error("PRIVY_NOT_CONFIGURED");

    const profile = await this.privyAuthService.verifyToken(input.privyToken);
    const { privyDid, email } = profile;

    // When a telegramChatId is provided, the user opening the Mini App is already
    // known to the bot via telegram_sessions. Reuse that existing userId so that
    // any pending signing requests (which were created with that userId) remain
    // accessible. Fall back to privyDid lookup only when no prior session exists.
    let user: IUser | null = null;
    if (input.telegramChatId && this.telegramSessionDB) {
      const existingSession = await this.telegramSessionDB.findByChatId(input.telegramChatId);
      if (existingSession) {
        user = await this.userDB.findById(existingSession.userId) ?? null;
        if (user && user.privyDid !== privyDid) {
          await this.userDB.linkPrivyDid(user.id, privyDid);
        }
      }
    }

    if (!user) {
      user = await this.userDB.findByPrivyDid(privyDid);
    }

    if (!user) {
      const userId = newUuid();
      const now = newCurrentUTCEpoch();
      const userName = email.split("@")[0] ?? "user";

      await this.userDB.create({
        id: userId,
        userName,
        email,
        privyDid,
        status: USER_STATUSES.ACTIVE,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });

      user = { id: userId, email, userName, privyDid, status: USER_STATUSES.ACTIVE, createdAtEpoch: now, updatedAtEpoch: now } satisfies IUser;
    }

    const expiresAtEpoch = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

    if (input.telegramChatId && this.telegramSessionDB) {
      await this.telegramSessionDB.upsert({
        telegramChatId: input.telegramChatId,
        userId: user.id,
        expiresAtEpoch,
      });
    }

    if (this.userProfileCache) {
      await this.userProfileCache.store(user.id, profile, SESSION_TTL_SECONDS).catch((err) => {
        console.error("[Auth] failed to store user profile:", err);
      });
    }

    if (input.telegramChatId && this.telegramNotifier) {
      await this.telegramNotifier.sendMessage(
        input.telegramChatId,
        AuthUseCaseImpl.WELCOME_BACK_TEXT,
      ).catch((err) => {
        console.error("[Auth] failed to send Telegram welcome message:", err);
      });
    }

    if (input.telegramChatId && this.telegramNotifier && this.tokenDelegationDB) {
      const delegations = await this.tokenDelegationDB.findActiveByUserId(user.id).catch(() => []);
      if (delegations.length === 0) {
        const miniAppUrl = process.env.MINI_APP_URL;
        if (miniAppUrl) {
          await this.telegramNotifier.sendMessage(
            input.telegramChatId,
            "Hey! To let me act on your behalf, I need a one-time permission.\n" +
            "Tap the button below — it takes about 10 seconds.",
            { webAppButton: { label: "Confirm", url: miniAppUrl } },
          ).catch((err) => {
            console.error("[Auth] failed to send delegation onboarding nudge:", err);
          });
        }
      }
    }

    return { userId: user.id, expiresAtEpoch };
  }

  async resolveUserId(privyToken: string): Promise<string | null> {
    if (!this.privyAuthService) return null;
    try {
      const { privyDid } = await this.privyAuthService.verifyTokenLite(privyToken);
      const user = await this.userDB.findByPrivyDid(privyDid);
      return user?.id ?? null;
    } catch {
      return null;
    }
  }
}
