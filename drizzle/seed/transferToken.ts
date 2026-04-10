/**
 * Seed script: injects an ERC-20 transfer tool manifest for Avalanche Fuji (chainId 43113)
 * Run with: npx ts-node drizzle/seed/transferToken.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { toolManifests } from "../../src/adapters/implementations/output/sqlDB/schema";
import { v4 as uuidv4 } from "uuid";
import { TOOL_CATEGORY } from "../../src/helpers/enums/toolCategory.enum";

const FUJI_CHAIN_ID = 43113;

const TRANSFER_TOOL = {
  toolId: "transfer",
  category: TOOL_CATEGORY.ERC20_TRANSFER,
  name: "ERC-20 Token Transfer",
  description: "Transfer any ERC-20 token (or native AVAX) to a recipient address on Avalanche.",
  protocolName: "Native ERC-20",
  tags: JSON.stringify(["transfer", "erc20", "send", "avax", "fuji"]),
  priority: 10,
  isDefault: true,
  inputSchema: JSON.stringify({
    type: "object",
    required: ["fromTokenSymbol", "amountHuman", "recipient"],
    properties: {
      fromTokenSymbol: {
        type: "string",
        description: "Symbol of the token to transfer, e.g. USDC, WAVAX",
      },
      amountHuman: {
        type: "string",
        description: "Amount in human-readable units, e.g. '10.5'",
      },
      recipient: {
        type: "string",
        description: "Recipient Ethereum address (0x...)",
      },
    },
  }),
  steps: JSON.stringify([
    {
      kind: "erc20_transfer",
      name: "transfer",
    },
  ]),
  preflightPreview: JSON.stringify({
    label: "Transfer",
    valueTemplate: "{{intent.amountHuman}} {{intent.fromTokenSymbol}} → {{intent.recipient}}",
  }),
  revenueWallet: null,
  isVerified: true,
  isActive: true,
  chainIds: JSON.stringify([FUJI_CHAIN_ID]),
};

async function seed() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/aether_intent",
  });
  const db = drizzle({ client: pool });

  const now = Math.floor(Date.now() / 1000);

  await db
    .insert(toolManifests)
    .values({
      id: uuidv4(),
      ...TRANSFER_TOOL,
      createdAtEpoch: now,
      updatedAtEpoch: now,
    })
    .onConflictDoUpdate({
      target: toolManifests.toolId,
      set: {
        name: TRANSFER_TOOL.name,
        description: TRANSFER_TOOL.description,
        inputSchema: TRANSFER_TOOL.inputSchema,
        steps: TRANSFER_TOOL.steps,
        preflightPreview: TRANSFER_TOOL.preflightPreview,
        isVerified: TRANSFER_TOOL.isVerified,
        isActive: TRANSFER_TOOL.isActive,
        updatedAtEpoch: now,
      },
    });

  console.log(`Seeded tool manifest: ${TRANSFER_TOOL.toolId}`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
