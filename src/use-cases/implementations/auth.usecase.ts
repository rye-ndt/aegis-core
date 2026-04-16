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
import type { ITelegramSessionDB } from "../interface/output/repository/telegramSession.repo";

const BCRYPT_ROUNDS = 10;

export class AuthUseCaseImpl implements IAuthUseCase {
  constructor(
    private readonly userDB: IUserDB,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
    private readonly privyAuthService?: IPrivyAuthService,
    private readonly telegramSessionDB?: ITelegramSessionDB,
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

    const { privyDid, email } = await this.privyAuthService.verifyToken(input.privyToken);

    let user = await this.userDB.findByPrivyDid(privyDid);

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

      user = { id: userId, email, userName, privyDid, status: USER_STATUSES.ACTIVE, createdAtEpoch: now, updatedAtEpoch: now };
    }

    const result = this.issueJwt(user.id, user.email);

    // If a Telegram chatId was provided, link it now in the same call.
    if (input.telegramChatId && this.telegramSessionDB) {
      await this.telegramSessionDB.upsert({
        telegramChatId: input.telegramChatId,
        userId: user.id,
        expiresAtEpoch: result.expiresAtEpoch,
      });
    }

    return result;
  }

  private issueJwt(userId: string, email: string): { token: string; expiresAtEpoch: number; userId: string } {
    const token = jwt.sign({ userId, email }, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    });
    const { exp } = jwt.decode(token) as { exp: number };
    return { token, expiresAtEpoch: exp, userId };
  }
}
