import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

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
    this.pool =
      "connectionString" in config
        ? new Pool({ connectionString: config.connectionString })
        : new Pool(config);
    this._db = drizzle({ client: this.pool });
  }

  /** Drizzle ORM instance for queries. Use in subclasses for select/insert/update/delete or sql\`\`. */
  protected get db(): NodePgDatabase {
    return this._db;
  }

  protected getPool(): Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

