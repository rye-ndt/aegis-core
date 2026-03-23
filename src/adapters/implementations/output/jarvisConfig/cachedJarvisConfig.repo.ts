import Redis from "ioredis";
import type {
  IJarvisConfigDB,
  JarvisConfig,
} from "../../../../use-cases/interface/output/repository/jarvisConfig.repo";
import { JARVIS_CONFIG_CACHE_KEY } from "../../../../helpers/enums/jarvisConfig.enum";

export class CachedJarvisConfigRepo implements IJarvisConfigDB {
  constructor(
    private readonly db: IJarvisConfigDB,
    private readonly redis: Redis,
  ) {}

  async get(): Promise<JarvisConfig | null> {
    const cached = await this.redis.get(JARVIS_CONFIG_CACHE_KEY);
    if (cached) return JSON.parse(cached) as JarvisConfig;

    const config = await this.db.get();
    if (config) {
      await this.redis.set(JARVIS_CONFIG_CACHE_KEY, JSON.stringify(config));
    }

    return config;
  }

  async update(systemPrompt: string): Promise<void> {
    await this.db.update(systemPrompt);
    await this.redis.del(JARVIS_CONFIG_CACHE_KEY);
  }
}
