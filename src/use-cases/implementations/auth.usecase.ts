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
  IRegisterInput,
} from "../interface/input/auth.interface";
import type { ISmartAccountService } from "../interface/output/blockchain/smartAccount.interface";
import type { ISessionKeyService } from "../interface/output/blockchain/sessionKey.interface";

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

    // Deploy SCA + grant session key if blockchain services are available
    if (this.smartAccountService && this.userProfileDB) {
      try {
        const { smartAccountAddress } = await this.smartAccountService.deploy(userId);

        let sessionKeyAddress: string | undefined;
        let sessionKeyStatus = SESSION_KEY_STATUSES.PENDING;
        const expiresAtEpoch = now + SESSION_KEY_DURATION_SECS;

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
        // Non-fatal: log and continue — user is created, SCA will be deployed lazily
        console.error("SCA deployment failed during registration:", err);
        await this.userProfileDB.upsert({
          userId,
          createdAtEpoch: now,
          updatedAtEpoch: now,
        });
      }
    }

    return { userId };
  }

  async login(input: ILoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }> {
    const user = await this.userDB.findByEmail(input.email);
    if (!user) throw new Error("INVALID_CREDENTIALS");

    const match = await bcrypt.compare(input.password, user.hashedPassword);
    if (!match) throw new Error("INVALID_CREDENTIALS");

    const payload = { userId: user.id, email: user.email };
    const token = jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    });

    const decoded = jwt.decode(token) as { exp: number };
    return { token, expiresAtEpoch: decoded.exp, userId: user.id };
  }

  async validateToken(token: string): Promise<{ userId: string; expiresAtEpoch: number }> {
    const payload = jwt.verify(token, this.jwtSecret) as { userId: string; exp: number };
    return { userId: payload.userId, expiresAtEpoch: payload.exp };
  }
}
