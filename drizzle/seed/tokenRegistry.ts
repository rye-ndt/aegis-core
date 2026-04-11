/**
 * Seed script: inserts verified tokens for Avalanche Fuji (chainId 43113)
 * Run with: npx ts-node drizzle/seed/tokenRegistry.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "../../node_modules/@types/pg";
import { tokenRegistry } from "../../src/adapters/implementations/output/sqlDB/schema";
import { v4 as uuidv4 } from "uuid";

const FUJI_CHAIN_ID = 43113;

const TOKENS = [
  {
    symbol: "AVAX",
    name: "Avalanche",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    isNative: true,
    isVerified: true,
  },
  {
    symbol: "WAVAX",
    name: "Wrapped AVAX",
    address: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
    decimals: 18,
    isNative: false,
    isVerified: true,
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x5425890298aed601595a70AB815c96711a31Bc65",
    decimals: 6,
    isNative: false,
    isVerified: true,
  },
];

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
        chainId: FUJI_CHAIN_ID,
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
