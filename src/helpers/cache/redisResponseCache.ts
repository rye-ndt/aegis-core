import type Redis from "ioredis";

export interface RedisResponseCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export function makeRedisResponseCache(redis: Redis, namespace: string): RedisResponseCache {
  const k = (key: string) => `${namespace}:${key}`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await redis.get(k(key));
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      await redis.set(k(key), JSON.stringify(value), "EX", ttlSeconds);
    },
  };
}
