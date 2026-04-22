import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { USER_STATUSES } from "../../helpers/enums/statuses.enum";
import type { IUserDB } from "../interface/output/repository/user.repo";
import type {
  IAuthUseCase,
  ILoginInput,
  IPrivyLoginInput,
  IRegisterInput,
} from "../interface/input/auth.interface";
import type { IPrivyAuthService } from "../interface/output/privyAuth.interface";
import type { IUser } from "../interface/output/repository/user.repo";
import type { ITelegramSessionDB } from "../interface/output/repository/telegramSession.repo";
import type { ITelegramNotifier } from "../interface/output/telegramNotifier.interface";
import type { IUserProfileCache } from "../interface/output/cache/userProfile.cache";
import type { ITokenDelegationDB } from "../interface/output/repository/tokenDelegation.repo";

const BCRYPT_ROUNDS = 10;

export class AuthUseCaseImpl implements IAuthUseCase {
  private static readonly WELCOME_BACK_TEXT =
    "You're now signed in to Aegis!\n\nYou can:\n• Describe a trade — the agent will parse and execute it\n• Send /new to start a fresh conversation\n• Send /history to see recent messages\n• Send /logout to sign out";

  constructor(
    private readonly userDB: IUserDB,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
    private readonly privyAuthService?: IPrivyAuthService,
    private readonly telegramSessionDB?: ITelegramSessionDB,
    private readonly telegramNotifier?: ITelegramNotifier,
    private readonly userProfileCache?: IUserProfileCache,
    private readonly tokenDelegationDB?: ITokenDelegationDB,
  ) {}

  async register(input: IRegisterInput): Promise<{ userId: string }> {
    const existing = await this.userDB.findByEmail(input.email);
    if (existing) throw new Error("EMAIL_TAKEN");

    const hashedPassword = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const now = newCurrentUTCEpoch();
    const userId = newUuid();

    await this.userDB.create({
      id: userId,
      userName: input.username,
      hashedPassword,
      email: input.email,
      status: USER_STATUSES.ACTIVE,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    });

    return { userId };
  }

  async login(input: ILoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }> {
    const user = await this.userDB.findByEmail(input.email);
    if (!user || !user.hashedPassword) throw new Error("INVALID_CREDENTIALS");

    const match = await bcrypt.compare(input.password, user.hashedPassword);
    if (!match) throw new Error("INVALID_CREDENTIALS");

    return this.issueJwt(user.id, user.email);
  }

  async validateToken(token: string): Promise<{ userId: string; expiresAtEpoch: number }> {
    const payload = jwt.verify(token, this.jwtSecret) as { userId: string; exp: number };
    return { userId: payload.userId, expiresAtEpoch: payload.exp };
  }

  async loginWithPrivy(input: IPrivyLoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }> {
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

    const result = this.issueJwt(user.id, user.email);

    if (input.telegramChatId && this.telegramSessionDB) {
      await this.telegramSessionDB.upsert({
        telegramChatId: input.telegramChatId,
        userId: user.id,
        expiresAtEpoch: result.expiresAtEpoch,
      });
    }

    // Store Privy profile in Redis
    if (this.userProfileCache) {
      const ttlSeconds = result.expiresAtEpoch - Math.floor(Date.now() / 1000);
      await this.userProfileCache.store(user.id, profile, ttlSeconds).catch((err) => {
        console.error("[Auth] failed to store user profile:", err);
      });
    }

    // Notify the user on Telegram
    if (input.telegramChatId && this.telegramNotifier) {
      await this.telegramNotifier.sendMessage(
        input.telegramChatId,
        AuthUseCaseImpl.WELCOME_BACK_TEXT,
      ).catch((err) => {
        console.error("[Auth] failed to send Telegram welcome message:", err);
      });
    }

    // Proactive onboarding: if the user has no active delegations, prompt them
    // to open the mini app and set spending limits.
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

    return result;
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

  private issueJwt(userId: string, email: string): { token: string; expiresAtEpoch: number; userId: string } {
    const token = jwt.sign({ userId, email }, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    });
    const { exp } = jwt.decode(token) as { exp: number };
    return { token, expiresAtEpoch: exp, userId };
  }
}
