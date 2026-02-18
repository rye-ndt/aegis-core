import Redis from "ioredis";
import { VERIFICATION_CODE_KEY_PREFIX } from "../../../../helpers/enums/verificationCode.enum";
import type {
  IVerificationCode,
  IVerificationCodeStore,
} from "../../../../use-cases/interface/output/verificationCodeStore.interface";
import { throwError } from "../../../../use-cases/interface/shared/error";
import { ERROR_CODES } from "../../../../helpers/enums/errorCodes.enum";

export interface RedisVerificationCodeStoreConfig {
  url: string;
}

export class RedisVerificationCodeStore implements IVerificationCodeStore {
  private readonly redis: Redis;

  constructor(config: RedisVerificationCodeStoreConfig) {
    this.redis = new Redis(config.url);
  }

  private key(email: string): string {
    return `${VERIFICATION_CODE_KEY_PREFIX.EMAIL}${email}`;
  }

  async set(
    key: string,
    verificationCode: IVerificationCode,
    ttlSeconds: number,
  ): Promise<void> {
    const k = this.key(key);
    const v = JSON.stringify(verificationCode);
    await this.redis.setex(k, ttlSeconds, v);
  }

  async get(key: string): Promise<IVerificationCode> {
    const k = this.key(key);
    const value = await this.redis.get(k);
    if (!value === null || typeof value !== "string") {
      throwError(ERROR_CODES.INVALID_VERIFICATION_CODE);
    }

    return JSON.parse(value as string) as IVerificationCode;
  }
}
