import jwt from "jsonwebtoken";
import Redis from "ioredis";
import {
  JWT_ALGORITHM,
  TOKEN_EXPIRY,
  TOKEN_REDIS_KEY_PREFIX,
} from "../../../../helpers/enums/tokenIssuer.enum";
import { newUuid } from "../../../../helpers/uuid";
import {
  ITokenIssuer,
  TokenPair,
  TokenType,
  VerifiedPayload,
} from "../../../../use-cases/interface/output/tokenIssuer.interface";
import { throwError } from "../../../../use-cases/interface/shared/error";
import { ERROR_CODES } from "../../../../helpers/enums/errorCodes.enum";

export interface JwtTokenIssuerConfig {
  secret: string;
  redisUrl: string;
}

export interface JwtPayload extends VerifiedPayload {
  jti?: string;
}

export class JwtTokenIssuer implements ITokenIssuer {
  private readonly redis: Redis;

  constructor(private readonly config: JwtTokenIssuerConfig) {
    this.redis = new Redis(config.redisUrl);
  }

  private bearerKey(userId: string): string {
    return `${TOKEN_REDIS_KEY_PREFIX.BEARER}${userId}`;
  }

  private bearerTtlSeconds(): number {
    const match = /^(\d+)([smhd])$/.exec(TOKEN_EXPIRY.BEARER);
    if (!match) {
      throwError(ERROR_CODES.INVALID_TOKEN);
    }

    const value = Number((match as RegExpExecArray)[1]);
    const unit = (match as RegExpExecArray)[2];

    if (unit === "s") {
      return value;
    }
    if (unit === "m") {
      return value * 60;
    }
    if (unit === "h") {
      return value * 60 * 60;
    }
    if (unit === "d") {
      return value * 60 * 60 * 24;
    }

    return throwError(ERROR_CODES.INVALID_TOKEN);
  }

  async issue(userId: string): Promise<TokenPair> {
    const bearerJti = newUuid();
    const refreshJti = newUuid();

    const bearerPayload: JwtPayload = {
      userId,
      type: TokenType.BEARER,
      jti: bearerJti,
    };

    const refreshPayload: JwtPayload = {
      userId,
      type: TokenType.REFRESH,
      jti: refreshJti,
    };

    const bearerToken = jwt.sign(bearerPayload, this.config.secret, {
      expiresIn: TOKEN_EXPIRY.BEARER,
      algorithm: JWT_ALGORITHM.HS256,
    });

    const bearerTtlSeconds = this.bearerTtlSeconds();
    await this.redis.setex(
      this.bearerKey(userId),
      bearerTtlSeconds,
      bearerToken,
    );

    const refreshToken = jwt.sign(refreshPayload, this.config.secret, {
      expiresIn: TOKEN_EXPIRY.REFRESH,
      algorithm: JWT_ALGORITHM.HS256,
    });

    return { bearerToken, refreshToken };
  }

  async verify(token: string): Promise<VerifiedPayload> {
    const payload = jwt.verify(token, this.config.secret, {
      algorithms: [JWT_ALGORITHM.HS256],
    }) as JwtPayload;

    if (payload.type === TokenType.BEARER) {
      const exists = await this.redis.exists(this.bearerKey(payload.userId));
      if (!exists) {
        throwError(ERROR_CODES.INVALID_TOKEN);
      }
    }

    return { userId: payload.userId, type: payload.type };
  }

  async isValid(token: string, type: TokenType): Promise<boolean> {
    const payload = await this.verify(token);
    return payload.type === type;
  }

  async revoke(token: string): Promise<void> {
    const payload = jwt.verify(token, this.config.secret, {
      algorithms: [JWT_ALGORITHM.HS256],
    }) as JwtPayload;

    if (payload.type !== TokenType.BEARER) {
      throwError(ERROR_CODES.INVALID_TOKEN);
    }

    await this.redis.del(this.bearerKey(payload.userId));
  }
}
