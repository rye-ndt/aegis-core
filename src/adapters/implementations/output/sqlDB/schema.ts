import { boolean, integer, jsonb, pgTable, text, uuid, unique } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password"),
  email: text("email").notNull().unique(),
  privyDid: text("privy_did").unique(),
  status: text("status").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const telegramSessions = pgTable("telegram_sessions", {
  telegramChatId: text("telegram_chat_id").primaryKey(),
  userId: uuid("user_id").notNull(),
  expiresAtEpoch: integer("expires_at_epoch").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  intent: text("intent"),
  flaggedForCompression: boolean("flagged_for_compression").notNull().default(false),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolName: text("tool_name"),
  toolCallId: text("tool_call_id"),
  toolCallsJson: text("tool_calls_json"),
  compressedAtEpoch: integer("compressed_at_epoch"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});

export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey(),
  telegramChatId: text("telegram_chat_id"),
  smartAccountAddress: text("smart_account_address"),
  eoaAddress: text("eoa_address"),
  sessionKeyAddress: text("session_key_address"),
  sessionKeyScope: text("session_key_scope"),
  sessionKeyStatus: text("session_key_status"),
  sessionKeyExpiresAtEpoch: integer("session_key_expires_at_epoch"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const tokenRegistry = pgTable("token_registry", {
  id: uuid("id").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  chainId: integer("chain_id").notNull(),
  address: text("address").notNull(),
  decimals: integer("decimals").notNull(),
  isNative: boolean("is_native").notNull().default(false),
  isVerified: boolean("is_verified").notNull().default(false),
  logoUri: text("logo_uri"),
  deployerAddress: text("deployer_address"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
}, (t) => ({
  symbolChainUniq: unique().on(t.symbol, t.chainId),
}));

export const intents = pgTable("intents", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  messageId: uuid("message_id").notNull(),
  rawInput: text("raw_input").notNull(),
  parsedJson: text("parsed_json").notNull(),
  status: text("status").notNull(),
  rejectionReason: text("rejection_reason"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const intentExecutions = pgTable("intent_executions", {
  id: uuid("id").primaryKey(),
  intentId: uuid("intent_id").notNull(),
  userId: uuid("user_id").notNull(),
  smartAccountAddress: text("smart_account_address").notNull(),
  solverUsed: text("solver_used").notNull(),
  simulationPassed: boolean("simulation_passed").notNull(),
  simulationResult: text("simulation_result"),
  userOpHash: text("user_op_hash"),
  txHash: text("tx_hash"),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  gasUsed: text("gas_used"),
  feeAmount: text("fee_amount"),
  feeToken: text("fee_token"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const toolManifests = pgTable("tool_manifests", {
  id:               uuid("id").primaryKey(),
  toolId:           text("tool_id").notNull().unique(),
  category:         text("category").notNull(),
  name:             text("name").notNull(),
  description:      text("description").notNull(),
  protocolName:     text("protocol_name").notNull(),
  tags:             text("tags").notNull(),
  priority:         integer("priority").notNull().default(0),
  isDefault:        boolean("is_default").notNull().default(false),
  inputSchema:      text("input_schema").notNull(),
  steps:            text("steps").notNull(),
  preflightPreview: text("preflight_preview"),
  revenueWallet:    text("revenue_wallet"),
  isVerified:       boolean("is_verified").notNull().default(false),
  isActive:         boolean("is_active").notNull().default(true),
  chainIds:         text("chain_ids").notNull(),
  requiredFields:   text("required_fields"),
  finalSchema:      text("final_schema"),
  createdAtEpoch:   integer("created_at_epoch").notNull(),
  updatedAtEpoch:   integer("updated_at_epoch").notNull(),
});

export const pendingDelegations = pgTable("pending_delegations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  zerodevMessage: jsonb("zerodev_message").notNull(),
  status: text("status").notNull(),           // 'pending' | 'signed' | 'expired'
  createdAtEpoch: integer("created_at_epoch").notNull(),
  expiresAtEpoch: integer("expires_at_epoch").notNull(),
});

export const feeRecords = pgTable("fee_records", {
  id: uuid("id").primaryKey(),
  executionId: uuid("execution_id").notNull(),
  userId: uuid("user_id").notNull(),
  totalFeeBps: integer("total_fee_bps").notNull(),
  platformFeeBps: integer("platform_fee_bps").notNull(),
  contributorFeeBps: integer("contributor_fee_bps").notNull(),
  feeTokenAddress: text("fee_token_address").notNull(),
  feeAmountRaw: text("fee_amount_raw").notNull(),
  platformAddress: text("platform_address").notNull(),
  contributorAddress: text("contributor_address"),
  txHash: text("tx_hash").notNull(),
  chainId: integer("chain_id").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});
