import { bigint, boolean, integer, jsonb, pgTable, text, uuid, unique, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password"),
  email: text("email").notNull().unique(),
  privyDid: text("privy_did").unique(),
  status: text("status").notNull(),
  loyaltyStatus: text("loyalty_status").notNull().default("normal"),
  telegramUsername: text("telegram_username"),
  telegramFirstName: text("telegram_first_name"),
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

// Explicit command → tool mapping (bare word stored, e.g. "buy" not "/buy")
export const commandToolMappings = pgTable("command_tool_mappings", {
  command:        text("command").primaryKey(),        // bare word, e.g. "buy"
  toolId:         text("tool_id").notNull(),           // references tool_manifests.tool_id (soft)
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const httpQueryTools = pgTable("http_query_tools", {
  id:                uuid("id").primaryKey(),
  userId:            uuid("user_id").notNull(),
  name:              text("name").notNull(),
  description:       text("description").notNull(),
  endpoint:          text("endpoint").notNull(),
  method:            text("method").notNull(),
  requestBodySchema: text("request_body_schema").notNull(),
  isActive:          boolean("is_active").notNull().default(true),
  createdAtEpoch:    integer("created_at_epoch").notNull(),
  updatedAtEpoch:    integer("updated_at_epoch").notNull(),
}, (t) => ({
  userNameUniq: unique().on(t.userId, t.name),
}));

export const httpQueryToolHeaders = pgTable("http_query_tool_headers", {
  id:             uuid("id").primaryKey(),
  toolId:         uuid("tool_id").notNull(),
  headerKey:      text("header_key").notNull(),
  headerValue:    text("header_value").notNull(),
  isEncrypted:    boolean("is_encrypted").notNull().default(false),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});

export const userPreferences = pgTable('user_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  aegisGuardEnabled: boolean('aegis_guard_enabled').notNull().default(false),
  updatedAtEpoch: integer('updated_at_epoch').notNull(),
});

export const yieldPositionSnapshots = pgTable("yield_position_snapshots", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  chainId: integer("chain_id").notNull(),
  protocolId: text("protocol_id").notNull(),
  tokenAddress: text("token_address").notNull(),
  snapshotDateUtc: text("snapshot_date_utc").notNull(),
  balanceRaw: text("balance_raw").notNull(),
  principalRaw: text("principal_raw").notNull(),
  snapshotAtEpoch: integer("snapshot_at_epoch").notNull(),
}, (t) => ({
  uniqueSnapshot: unique().on(t.userId, t.chainId, t.protocolId, t.tokenAddress, t.snapshotDateUtc),
}));

export const tokenDelegations = pgTable('token_delegations', {
  id:             uuid('id').primaryKey(),
  userId:         uuid('user_id').notNull(),
  tokenAddress:   text('token_address').notNull(),   // ERC20 address or 0xEeee…EEeE for native
  tokenSymbol:    text('token_symbol').notNull(),
  tokenDecimals:  integer('token_decimals').notNull(),
  limitRaw:       text('limit_raw').notNull(),        // bigint as decimal string
  spentRaw:       text('spent_raw').notNull().default('0'),
  validUntil:     integer('valid_until').notNull(),   // unix epoch seconds
  createdAtEpoch: integer('created_at_epoch').notNull(),
  updatedAtEpoch: integer('updated_at_epoch').notNull(),
}, (t) => ({
  userTokenUniq: unique().on(t.userId, t.tokenAddress),
}));

export const loyaltyActionTypes = pgTable("loyalty_action_types", {
  id:              text("id").primaryKey(),
  displayName:     text("display_name").notNull(),
  defaultBase:     bigint("default_base", { mode: "bigint" }).notNull(),
  isActive:        boolean("is_active").notNull().default(true),
  createdAtEpoch:  integer("created_at_epoch").notNull(),
});

export const loyaltySeasons = pgTable("loyalty_seasons", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  startsAtEpoch:   integer("starts_at_epoch").notNull(),
  endsAtEpoch:     integer("ends_at_epoch").notNull(),
  status:          text("status").notNull(),
  formulaVersion:  text("formula_version").notNull(),
  configJson:      jsonb("config_json").notNull(),
  createdAtEpoch:  integer("created_at_epoch").notNull(),
  updatedAtEpoch:  integer("updated_at_epoch").notNull(),
});

export const recipientNotifications = pgTable("recipient_notifications", {
  id: uuid("id").primaryKey(),
  recipientTelegramUserId: text("recipient_telegram_user_id").notNull(),
  recipientUserId: uuid("recipient_user_id"),
  recipientChatId: text("recipient_chat_id"),
  senderUserId: uuid("sender_user_id").notNull(),
  senderChatId: text("sender_chat_id").notNull(),
  senderDisplayName: text("sender_display_name"),
  senderHandle: text("sender_handle"),
  kind: text("kind").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  amountFormatted: text("amount_formatted").notNull(),
  chainId: integer("chain_id").notNull(),
  txHash: text("tx_hash"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  deliveredAtEpoch: integer("delivered_at_epoch"),
}, (t) => ({
  byTelegramUser: index("recipient_notif_by_tg_user_idx")
    .on(t.recipientTelegramUserId, t.status),
  byCreatedAt: index("recipient_notif_created_at_idx").on(t.createdAtEpoch),
}));

export const predictionMarketRuns = pgTable("prediction_market_runs", {
  runId: uuid("run_id").primaryKey(),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
  universeHash: text("universe_hash").notNull(),
  clusterSetHash: text("cluster_set_hash"),
  status: text("status").notNull(),                                    // 'fetched' | 'clustered' | 'published' | 'failed'
  isLatest: boolean("is_latest").notNull().default(false),
}, (t) => ({
  byCreatedAt: index("pm_runs_created_at_idx").on(t.createdAtEpoch),
  byLatest: index("pm_runs_is_latest_idx").on(t.isLatest),
}));

export const predictionMarketSnapshots = pgTable("prediction_market_snapshots", {
  runId: uuid("run_id").notNull(),
  marketId: text("market_id").notNull(),
  slug: text("slug").notNull(),
  question: text("question").notNull(),
  resolutionCriteria: text("resolution_criteria").notNull(),
  category: text("category"),
  resolutionEpochSec: bigint("resolution_epoch_sec", { mode: "number" }).notNull(),
  yesPriceBp: integer("yes_price_bp").notNull(),                       // 0..10000
  noPriceBp: integer("no_price_bp").notNull(),                         // 0..10000
  openInterestUsdCents: bigint("open_interest_usd_cents", { mode: "number" }).notNull(),
  volume7dUsdCents: bigint("volume_7d_usd_cents", { mode: "number" }).notNull(),
  liquidityUsdCents: bigint("liquidity_usd_cents", { mode: "number" }).notNull(),
  url: text("url").notNull(),
}, (t) => ({
  pk: unique("pm_snapshots_run_market_uniq").on(t.runId, t.marketId),
  byRun: index("pm_snapshots_by_run").on(t.runId),
}));

export const predictionMarketClusters = pgTable("prediction_market_clusters", {
  clusterId: uuid("cluster_id").primaryKey(),
  runId: uuid("run_id").notNull(),
  theme: text("theme").notNull(),
  causalDriver: text("causal_driver").notNull(),
  marketIds: jsonb("market_ids").notNull(),                            // string[]
  expectedRelationships: jsonb("expected_relationships").notNull(),    // ExpectedRelationship[]
  rationale: text("rationale").notNull(),
  confidence: text("confidence").notNull(),                            // 'low' | 'medium' | 'high'
}, (t) => ({
  byRun: index("pm_clusters_by_run").on(t.runId),
}));

export const predictionMarketFindings = pgTable("prediction_market_findings", {
  findingId: uuid("finding_id").primaryKey(),
  runId: uuid("run_id").notNull(),
  // Stable across runs (carry-forward preserves clusterId). Allows analytical
  // queries like "how often did cluster X surface a finding?".
  clusterId: uuid("cluster_id").notNull(),
  patternType: text("pattern_type").notNull(),                         // FindingPatternType
  marketsInvolved: jsonb("markets_involved").notNull(),                // string[]
  currentState: jsonb("current_state").notNull(),                      // FindingCurrentState
  liveOdds: jsonb("live_odds").notNull(),                              // Record<marketId, 0..1>
  whyAnomalous: text("why_anomalous").notNull(),
  sideA: jsonb("side_a").notNull(),                                    // SideThesis
  sideB: jsonb("side_b").notNull(),                                    // SideThesis
  confidence: text("confidence").notNull(),                            // 'low' | 'medium' | 'high'
  magnitudeBps: integer("magnitude_bps").notNull(),
  rankScore: integer("rank_score").notNull(),                          // ×1000 to keep int
  rationale: text("rationale").notNull(),
  createdAtEpoch: bigint("created_at_epoch", { mode: "number" }).notNull(),
  broadcastedAtEpoch: bigint("broadcasted_at_epoch", { mode: "number" }),
  // Manual labelling — populated post-resolution to compute precision and
  // win-rate over the held-out window. Nullable; default null. Values:
  // 'true_positive' | 'false_positive' | 'unresolved'.
  editorialOutcome: text("editorial_outcome"),
}, (t) => ({
  byRun: index("pm_findings_by_run").on(t.runId),
  byCluster: index("pm_findings_by_cluster").on(t.clusterId),
  byCreated: index("pm_findings_by_created").on(t.createdAtEpoch),
}));

export const loyaltyPointsLedger = pgTable("loyalty_points_ledger", {
  id:                  text("id").primaryKey(),
  userId:              uuid("user_id").notNull().references(() => users.id),
  seasonId:            text("season_id").notNull().references(() => loyaltySeasons.id),
  actionType:          text("action_type").notNull().references(() => loyaltyActionTypes.id),
  pointsRaw:           bigint("points_raw", { mode: "bigint" }).notNull(),
  intentExecutionId:   uuid("intent_execution_id"),
  externalRef:         text("external_ref"),
  formulaVersion:      text("formula_version").notNull(),
  computedFromJson:    jsonb("computed_from_json").notNull(),
  metadataJson:        jsonb("metadata_json"),
  createdAtEpoch:      integer("created_at_epoch").notNull(),
}, (t) => ({
  userSeasonIdx:         index().on(t.userId, t.seasonId),
  seasonPointsIdx:       index().on(t.seasonId, t.pointsRaw.desc()),
  intentExecutionUniq:   unique("loyalty_ledger_intent_execution_uniq").on(t.intentExecutionId),
  userActionRefUniq:     unique("loyalty_ledger_user_action_ref_uniq").on(t.userId, t.actionType, t.externalRef),
}));

