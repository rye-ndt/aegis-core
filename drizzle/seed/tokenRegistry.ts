/**
 * Seed script: inserts verified ERC-20 tokens for the configured Avalanche chain.
 * Driven by CHAIN_ID env (defaults to 43114 mainnet); 43113 (Fuji) also supported.
 * Run with: npx ts-node drizzle/seed/tokenRegistry.ts
 *
 * Native tokens (AVAX/ETH/POL/...) are intentionally NOT seeded — they're
 * synthesised on the fly by `DbTokenRegistryService` from
 * `chainConfig.getNativeTokenInfo(chainId)`. Seeding native rows risks
 * indexer collisions on the (symbol, chainId) upsert key, so we keep
 * native handling out of the DB entirely.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "../../node_modules/@types/pg";
import { tokenRegistry } from "../../src/adapters/implementations/output/sqlDB/schema";
import { v4 as uuidv4 } from "uuid";

const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "43114", 10);

type TokenSeed = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  isNative: boolean;
  isVerified: boolean;
};

const TOKENS_BY_CHAIN: Record<number, TokenSeed[]> = {
  43114: [
    { symbol: "WAVAX", name: "Wrapped AVAX", address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", decimals: 18, isNative: false, isVerified: true },
    { symbol: "USDC",  name: "USD Coin",     address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6,  isNative: false, isVerified: true },
  ],
  43113: [
    { symbol: "WAVAX", name: "Wrapped AVAX", address: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c", decimals: 18, isNative: false, isVerified: true },
    { symbol: "USDC",  name: "USD Coin",     address: "0x5425890298aed601595a70AB815c96711a31Bc65", decimals: 6,  isNative: false, isVerified: true },
  ],
};

const TOKENS = TOKENS_BY_CHAIN[CHAIN_ID];
if (!TOKENS) throw new Error(`No token seed defined for CHAIN_ID=${CHAIN_ID}`);

async function seed() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://localhost:5432/aether_intent",
  });
  const db = drizzle({ client: pool });

  const now = Math.floor(Date.now() / 1000);

  for (const token of TOKENS) {
    await db
      .insert(tokenRegistry)
      .values({
        id: uuidv4(),
        symbol: token.symbol,
        name: token.name,
        chainId: CHAIN_ID,
        address: token.address,
        decimals: token.decimals,
        isNative: token.isNative,
        isVerified: token.isVerified,
        createdAtEpoch: now,
        updatedAtEpoch: now,
      })
      .onConflictDoUpdate({
        target: [tokenRegistry.symbol, tokenRegistry.chainId],
        set: {
          address: token.address,
          decimals: token.decimals,
          isNative: token.isNative,
          isVerified: token.isVerified,
          updatedAtEpoch: now,
        },
      });
    console.log(`Seeded ${token.symbol}`);
  }

  await pool.end();
  console.log("Token registry seeded successfully.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
