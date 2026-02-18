import type { IUserDB } from "../../use-cases/interface/output/repository/user.repo";
import type { ITokenIssuer } from "../../use-cases/interface/output/tokenIssuer.interface";
import type { IUserUseCase } from "../../use-cases/interface/input/user.interface";
import { UserUseCaseImpl } from "../../use-cases/implementations/user.usecase";
import type { IPasswordHasher } from "../../use-cases/interface/output/passwordHasher.interface";
import type { IEmailSender } from "../../use-cases/interface/output/emailSender.interface";
import type { IVerificationCodeStore } from "../../use-cases/interface/output/verificationCodeStore.interface";
import { BcryptPasswordHasher } from "../implementations/output/passwordHasher/bcrypt.passwordHasher";
import { UnosendEmailSender } from "../implementations/output/emailSender/unosend.emailSender";
import { RedisVerificationCodeStore } from "../implementations/output/verificationCodeStore/redis.verificationCodeStore";

export class UserInject {
  private passwordHasher: IPasswordHasher | null = null;
  private emailSender: IEmailSender | null = null;
  private verificationCodeStore: IVerificationCodeStore | null = null;

  getPasswordHasher(): IPasswordHasher {
    if (!this.passwordHasher) {
      this.passwordHasher = new BcryptPasswordHasher();
    }
    return this.passwordHasher;
  }

  getEmailSender(): IEmailSender {
    if (!this.emailSender) {
      this.emailSender = new UnosendEmailSender({
        apiKey: process.env.UNOSEND_API_KEY ?? "",
        from: process.env.UNOSEND_FROM_EMAIL ?? "",
      });
    }
    return this.emailSender;
  }

  getVerificationCodeStore(): IVerificationCodeStore {
    if (!this.verificationCodeStore) {
      this.verificationCodeStore = new RedisVerificationCodeStore({
        url: process.env.REDIS_URL ?? "redis://localhost:6379",
      });
    }
    return this.verificationCodeStore;
  }

  getUseCase(userRepo: IUserDB, tokenIssuer: ITokenIssuer): IUserUseCase {
    return new UserUseCaseImpl(
      userRepo,
      this.getPasswordHasher(),
      tokenIssuer,
      this.getEmailSender(),
      this.getVerificationCodeStore(),
    );
  }
}
