import type { IUserDB } from "../../use-cases/interface/output/repository/user.repo";
import { JwtTokenIssuer } from "../implementations/output/tokenIssuer/jwt.tokenIssuer";
import type { ITokenIssuer } from "../../use-cases/interface/output/tokenIssuer.interface";
import type { IUserUseCase } from "../../use-cases/interface/input/user.interface";
import { UserUseCaseImpl } from "../../use-cases/implementations/user.usecase";
import type { IEmailSender } from "../../use-cases/interface/output/emailSender.interface";
import type { IVerificationCodeStore } from "../../use-cases/interface/output/verificationCodeStore.interface";
import { BcryptPasswordHasher } from "../implementations/output/passwordHasher/bcrypt.passwordHasher";
import { UnosendEmailSender } from "../implementations/output/emailSender/unosend.emailSender";
import { RedisVerificationCodeStore } from "../implementations/output/verificationCodeStore/redis.verificationCodeStore";
import { UserControllerConcrete } from "../implementations/input/http/user.controller";
import { IPasswordHasher } from "../../use-cases/interface/output/passwordHasher.interface";
import { DrizzleSqlDB } from "../implementations/output/sqlDB/drizzleSqlDb.adapter";

export class UserInject {
  private sqlDB: DrizzleSqlDB | null = null;
  private userRepo: IUserDB | null = null;
  private tokenIssuer: ITokenIssuer | null = null;
  private passwordHasher: IPasswordHasher | null = null;
  private emailSender: IEmailSender | null = null;
  private verificationCodeStore: IVerificationCodeStore | null = null;
  private useCase: IUserUseCase | null = null;
  private ctl: UserControllerConcrete | null = null;

  getSqlDB(): DrizzleSqlDB {
    if (!this.sqlDB) {
      this.sqlDB = new DrizzleSqlDB({
        connectionString:
          process.env.DATABASE_URL ?? "postgres://localhost:5432/memora",
      });
    }
    return this.sqlDB;
  }

  getUserRepo(): IUserDB {
    if (!this.userRepo) {
      this.userRepo = this.getSqlDB().users;
    }
    return this.userRepo;
  }

  getTokenIssuer(): ITokenIssuer {
    if (!this.tokenIssuer) {
      this.tokenIssuer = new JwtTokenIssuer({
        secret: process.env.JWT_SECRET ?? "",
        redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
      });
    }
    return this.tokenIssuer;
  }

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

  getUseCase(): IUserUseCase {
    if (!this.useCase) {
      this.useCase = new UserUseCaseImpl(
        this.getUserRepo(),
        this.getPasswordHasher(),
        this.getTokenIssuer(),
        this.getEmailSender(),
        this.getVerificationCodeStore(),
      );
    }
    return this.useCase;
  }

  getCtl(): UserControllerConcrete {
    if (!this.ctl) {
      this.ctl = new UserControllerConcrete(this.getUseCase());
    }
    return this.ctl;
  }
}
