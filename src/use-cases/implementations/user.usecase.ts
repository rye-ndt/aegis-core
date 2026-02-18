import { UserEntity } from "../../core/entities/User";
import { ERROR_CODES } from "../../helpers/enums/errorCodes.enum";
import { USER_ROLES } from "../../helpers/enums/userRole.enum";
import { VERIFICATION_CODE_TTL } from "../../helpers/enums/verificationCode.enum";
import { VERIFICATION_EMAIL_SUBJECT } from "../../helpers/enums/verificationEmail.enum";
import { newCurrentUTCEpoch } from "../../helpers/time/dateTime";
import { newUuid } from "../../helpers/uuid";
import { generateVerificationCode } from "../../helpers/verificationCode";
import {
  ILoginUser,
  IRegisterUser,
  IUser,
  IUserUseCase,
} from "../interface/input/user.interface";
import type { IEmailSender } from "../interface/output/emailSender.interface";
import type {
  IUserDB,
  IUser as RepoUser,
  UserInit,
  UserUpdate,
} from "../interface/output/repository/user.repo";
import {
  TokenType,
  type ITokenIssuer,
} from "../interface/output/tokenIssuer.interface";
import type { IPasswordHasher } from "../interface/output/passwordHasher.interface";
import type {
  IVerificationCode,
  IVerificationCodeStore,
} from "../interface/output/verificationCodeStore.interface";
import { throwError } from "../interface/shared/error";

export class UserUseCaseImpl implements IUserUseCase {
  constructor(
    private readonly userRepo: IUserDB,
    private readonly passwordHasher: IPasswordHasher,
    private readonly tokenIssuer: ITokenIssuer,
    private readonly emailSender: IEmailSender,
    private readonly verificationCodeStore: IVerificationCodeStore,
  ) {}

  async register(data: IRegisterUser): Promise<IUser> {
    await this.assertUserDoesNotExist(data.userName, data.email);

    const user = this.createNewUser(data.email, data.password);

    const now = newCurrentUTCEpoch();
    const id = newUuid();

    const hashedPassword = await this.passwordHasher.hash(data.password);

    const init: UserInit = {
      id,
      fullName: data.fullName,
      userName: data.userName,
      hashedPassword,
      email: data.email,
      dob: data.dob,
      role: USER_ROLES.USER,
      status: user.getStatus(),
      createdAtEpoch: now,
      updatedAtEpoch: now,
    };

    await this.userRepo.create(init);

    const verificationCode = this.newVerificationCode(now);
    await this.storeVerificationCode(data.email, verificationCode);
    await this.sendVerificationEmail(data.email, verificationCode.code);

    const tokens = await this.tokenIssuer.issue(init.id);

    return {
      id: init.id,
      fullName: init.fullName,
      userName: init.userName,
      role: init.role,
      status: init.status,
      bearerToken: tokens.bearerToken,
      refreshToken: tokens.refreshToken,
      lastEmailSentEpoch: now,
      registeredAtEpoch: init.createdAtEpoch,
    };
  }

  async verifyEmail(bearer: string, code: string): Promise<IUser> {
    const payload = await this.tokenIssuer.verify(bearer);
    this.assertBearerToken(payload.type);

    const existingUser = await this.getExistingUser(payload.userId);

    const user = new UserEntity({
      email: existingUser.email,
      status: existingUser.status,
    });

    const storedCode = await this.verificationCodeStore.get(user.getEmail());
    user.verifyEmail(storedCode.code, code);

    const updatedAtEpoch = newCurrentUTCEpoch();
    await this.userRepo.update({
      id: existingUser.id,
      fullName: existingUser.fullName,
      userName: existingUser.userName,
      hashedPassword: existingUser.hashedPassword,
      email: existingUser.email,
      dob: existingUser.dob,
      role: existingUser.role,
      status: user.getStatus(),
      updatedAtEpoch,
    });

    const { bearerToken, refreshToken } = await this.tokenIssuer.issue(
      existingUser.id,
    );

    return {
      id: existingUser.id,
      fullName: existingUser.fullName,
      userName: existingUser.userName,
      role: existingUser.role,
      status: user.getStatus(),
      bearerToken,
      refreshToken,
      lastEmailSentEpoch: storedCode.createdAtEpoch,
      registeredAtEpoch: existingUser.createdAtEpoch,
    };
  }

  async login(data: ILoginUser): Promise<IUser> {
    const existing = await this.userRepo.findByUsernameOrEmail(
      data.userName,
      data.userName,
    );

    if (existing === null) throwError(ERROR_CODES.USER_NOT_FOUND);

    const user = existing as RepoUser;

    const isPasswordValid = await this.passwordHasher.compare(
      data.password,
      user.hashedPassword,
    );

    if (!isPasswordValid) throwError(ERROR_CODES.USER_NOT_FOUND);

    const { bearerToken, refreshToken } = await this.tokenIssuer.issue(user.id);

    return {
      id: user.id,
      fullName: user.fullName,
      userName: user.userName,
      role: user.role,
      status: user.status,
      bearerToken,
      refreshToken,
      lastEmailSentEpoch: user.createdAtEpoch,
      registeredAtEpoch: user.createdAtEpoch,
    };
  }

  async logout(accessToken: string): Promise<void> {
    const payload = await this.tokenIssuer.verify(accessToken);
    this.assertBearerToken(payload.type);
    return await this.tokenIssuer.revoke(accessToken);
  }

  async refresh(refreshToken: string): Promise<IUser> {
    const payload = await this.tokenIssuer.verify(refreshToken);

    if (payload.type !== TokenType.REFRESH) {
      throwError(ERROR_CODES.INVALID_TOKEN);
    }

    const existingUser = await this.getExistingUser(payload.userId);

    const { bearerToken, refreshToken: newRefreshToken } =
      await this.tokenIssuer.issue(existingUser.id);

    return {
      id: existingUser.id,
      fullName: existingUser.fullName,
      userName: existingUser.userName,
      role: existingUser.role,
      status: existingUser.status,
      bearerToken,
      refreshToken: newRefreshToken,
      lastEmailSentEpoch: existingUser.createdAtEpoch,
      registeredAtEpoch: existingUser.createdAtEpoch,
    };
  }

  private async assertUserDoesNotExist(
    userName: string,
    email: string,
  ): Promise<void> {
    const existing = await this.userRepo.findByUsernameOrEmail(userName, email);
    if (existing !== null) throwError(ERROR_CODES.USER_ALREADY_EXISTS);
  }

  private assertBearerToken(type: TokenType): void {
    if (type !== TokenType.BEARER) throwError(ERROR_CODES.INVALID_TOKEN);
  }

  private async getExistingUser(userId: string): Promise<RepoUser> {
    const repoUser = await this.userRepo.findById(userId);
    if (repoUser === undefined) throwError(ERROR_CODES.USER_NOT_FOUND);
    return repoUser as RepoUser;
  }

  private createNewUser(email: string, plainPassword: string): UserEntity {
    const user = new UserEntity({ email });
    user.usePassword(plainPassword);
    return user;
  }

  private newVerificationCode(createdAtEpoch: number): IVerificationCode {
    return {
      code: generateVerificationCode(),
      createdAtEpoch,
    };
  }

  private async storeVerificationCode(
    email: string,
    verificationCode: IVerificationCode,
  ): Promise<void> {
    await this.verificationCodeStore.set(
      email,
      verificationCode,
      VERIFICATION_CODE_TTL.SECONDS_30_MIN,
    );
  }

  private async sendVerificationEmail(
    email: string,
    verificationCode: string,
  ): Promise<void> {
    await this.emailSender.send({
      to: [email],
      subject: VERIFICATION_EMAIL_SUBJECT.CODE,
      html: `<p>Your verification code is: <strong>${verificationCode}</strong>. It expires in 30 minutes.</p>`,
    });
  }
}
