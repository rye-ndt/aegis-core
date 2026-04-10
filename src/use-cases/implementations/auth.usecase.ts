import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { USER_STATUSES } from "../../helpers/enums/statuses.enum";
import { SESSION_KEY_STATUSES } from "../../helpers/enums/sessionKeyStatus.enum";
import type { IUserDB } from "../interface/output/repository/user.repo";
import type { IUserProfileDB } from "../interface/output/repository/userProfile.repo";
import type {
  IAuthUseCase,
  ILoginInput,
  IPrivyLoginInput,
  IRegisterInput,
} from "../interface/input/auth.interface";
import type { ISmartAccountService } from "../interface/output/blockchain/smartAccount.interface";
import type { ISessionKeyService } from "../interface/output/blockchain/sessionKey.interface";
import type { IPrivyAuthService } from "../interface/output/privyAuth.interface";

const BCRYPT_ROUNDS = 10;
const SESSION_KEY_DURATION_SECS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_MAX_AMOUNT_PER_TX_USD = 1000;

export class AuthUseCaseImpl implements IAuthUseCase {
  constructor(
    private readonly userDB: IUserDB,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
    private readonly userProfileDB?: IUserProfileDB,
    private readonly smartAccountService?: ISmartAccountService,
    private readonly sessionKeyService?: ISessionKeyService,
    private readonly allowedTokenAddresses?: string[],
    private readonly privyAuthService?: IPrivyAuthService,
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

    await this.deployOnChain(userId, now);
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

      await this.deployOnChain(userId, now);

      user = { id: userId, email, userName, privyDid, status: USER_STATUSES.ACTIVE, createdAtEpoch: now, updatedAtEpoch: now };
    }

    return this.issueJwt(user.id, user.email);
  }

  private async deployOnChain(userId: string, now: number): Promise<void> {
    if (!this.smartAccountService || !this.userProfileDB) return;

    try {
      const { smartAccountAddress } = await this.smartAccountService.deploy(userId);
      const expiresAtEpoch = now + SESSION_KEY_DURATION_SECS;
      let sessionKeyAddress: string | undefined;
      let sessionKeyStatus = SESSION_KEY_STATUSES.PENDING;

      if (this.sessionKeyService) {
        const scope = {
          maxAmountPerTxUsd: DEFAULT_MAX_AMOUNT_PER_TX_USD,
          allowedTokenAddresses: this.allowedTokenAddresses ?? [],
          expiresAtEpoch,
        };
        const grantResult = await this.sessionKeyService.grant({ smartAccountAddress, scope });
        sessionKeyAddress = grantResult.sessionKeyAddress;
        sessionKeyStatus = SESSION_KEY_STATUSES.ACTIVE;
      }

      await this.userProfileDB.upsert({
        userId,
        smartAccountAddress,
        sessionKeyAddress: sessionKeyAddress ?? null,
        sessionKeyScope: JSON.stringify({
          maxAmountPerTxUsd: DEFAULT_MAX_AMOUNT_PER_TX_USD,
          allowedTokenAddresses: this.allowedTokenAddresses ?? [],
          expiresAtEpoch,
        }),
        sessionKeyStatus,
        sessionKeyExpiresAtEpoch: expiresAtEpoch,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      });
    } catch (err) {
      // Non-fatal: user is created, SCA will be deployed lazily
      console.error("SCA deployment failed:", err);
      await this.userProfileDB.upsert({ userId, createdAtEpoch: now, updatedAtEpoch: now });
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
