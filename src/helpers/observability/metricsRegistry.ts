import { openaiLimiter, OPENAI_CONCURRENCY } from "../concurrency/openaiLimiter";
import type { Pool } from "pg";
import type Redis from "ioredis";

class RollingHistogram {
  private samples: number[] = [];
  private readonly capacity = 512;

  record(ms: number): void {
    if (this.samples.length >= this.capacity) this.samples.shift();
    this.samples.push(ms);
  }

  snapshot(): { p50: number; p95: number; count: number; total: number } {
    if (this.samples.length === 0) return { p50: 0, p95: 0, count: 0, total: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const total = sorted.reduce((a, b) => a + b, 0);
    return { p50, p95, count: sorted.length, total };
  }
}

class MetricsRegistry {
  private readonly llmLatency = new RollingHistogram();
  private readonly redisLatency = new RollingHistogram();
  private llmCacheHitTokens = 0;
  private llmPromptTokens = 0;
  private llmCompletionTokens = 0;

  private pgPool?: Pool;
  private redis?: Redis;

  bindPgPool(pool: Pool): void { this.pgPool = pool; }
  bindRedis(redis: Redis): void { this.redis = redis; }

  recordLlmCall(ms: number, promptTokens: number, cachedTokens: number, completionTokens: number): void {
    this.llmLatency.record(ms);
    this.llmPromptTokens += promptTokens;
    this.llmCacheHitTokens += cachedTokens;
    this.llmCompletionTokens += completionTokens;
  }

  recordRedisOp(ms: number): void {
    this.redisLatency.record(ms);
  }

  snapshot() {
    const llm = this.llmLatency.snapshot();
    const redis = this.redisLatency.snapshot();
    return {
      process: {
        role: process.env.PROCESS_ROLE ?? "combined",
        uptimeSeconds: Math.floor(process.uptime()),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      pgPool: this.pgPool ? {
        total: this.pgPool.totalCount,
        idle: this.pgPool.idleCount,
        waiting: this.pgPool.waitingCount,
      } : null,
      openaiLimiter: {
        active: openaiLimiter.activeCount,
        pending: openaiLimiter.pendingCount,
        concurrency: OPENAI_CONCURRENCY,
      },
      llm: {
        p50Ms: llm.p50,
        p95Ms: llm.p95,
        callCount: llm.count,
        promptTokens: this.llmPromptTokens,
        cachedTokens: this.llmCacheHitTokens,
        cacheHitRatio: this.llmPromptTokens > 0 ? (this.llmCacheHitTokens / this.llmPromptTokens) : 0,
        completionTokens: this.llmCompletionTokens,
      },
      redis: {
        p50Ms: redis.p50,
        p95Ms: redis.p95,
        opCount: redis.count,
      },
    };
  }
}

export const metricsRegistry = new MetricsRegistry();
