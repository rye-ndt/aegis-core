import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { metricsRegistry } from "../../../../helpers/observability/metricsRegistry";

const POOL_MAX = Number(process.env.DB_POOL_MAX ?? 25);
const POOL_IDLE_TIMEOUT_MS = Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000);
const POOL_CONNECTION_TIMEOUT_MS = Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000);

export type PostgresConfig =
  | { connectionString: string }
  | {
      host: string;
      port?: number;
      user: string;
      password: string;
      database: string;
    };

export class PostgresDB {
  private readonly pool: Pool;
  private readonly _db: NodePgDatabase;

  constructor(config: PostgresConfig) {
    const poolOptions = {
      max: POOL_MAX,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    };
    this.pool =
      "connectionString" in config
        ? new Pool({ connectionString: config.connectionString, ...poolOptions })
        : new Pool({ ...config, ...poolOptions });
    this._db = drizzle({ client: this.pool });
    metricsRegistry.bindPgPool(this.pool);
  }

  /** Drizzle ORM instance for queries. Use in subclasses for select/insert/update/delete or sql\`\`. */
  protected get db(): NodePgDatabase {
    return this._db;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

