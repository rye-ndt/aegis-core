import { boolean, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  email: text("email").notNull(),
  dob: integer("dob").notNull(),
  status: text("status").notNull(),
  personalities: text("personalities").array().notNull().default([]),
  secondaryPersonalities: text("secondary_personalities")
    .array()
    .notNull()
    .default([]),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
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

export const jarvisConfig = pgTable("jarvis_config", {
  id: text("id").primaryKey(),
  systemPrompt: text("system_prompt").notNull(),
  maxToolRounds: integer("max_tool_rounds"),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const googleOAuthTokens = pgTable("google_oauth_tokens", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAtEpoch: integer("expires_at_epoch").notNull(),
  scope: text("scope").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const userMemories = pgTable("user_memories", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  content: text("content").notNull(),
  enrichedContent: text("enriched_content"),
  category: text("category"),
  pineconeId: text("pinecone_id").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
  lastAccessedEpoch: integer("last_accessed_epoch").notNull(),
});

export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey(),
  displayName: text("display_name"),
  personalities: text("personalities").array().notNull().default([]),
  wakeUpHour: integer("wake_up_hour"),
  telegramChatId: text("telegram_chat_id"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const todoItems = pgTable("todo_items", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  deadlineEpoch: integer("deadline_epoch").notNull(),
  priority: text("priority").notNull(),
  status: text("status").notNull(),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});

export const evaluationLogs = pgTable("evaluation_logs", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  messageId: uuid("message_id").notNull(),
  userId: uuid("user_id").notNull(),
  systemPromptHash: text("system_prompt_hash").notNull(),
  memoriesInjected: text("memories_injected").notNull().default("[]"),
  toolCalls: text("tool_calls").notNull().default("[]"),
  reasoningTrace: text("reasoning_trace"),
  response: text("response").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  implicitSignal: text("implicit_signal"),
  explicitRating: integer("explicit_rating"),
  outcomeConfirmed: boolean("outcome_confirmed"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
});

export const allowedTelegramIds = pgTable("allowed_telegram_ids", {
  telegramChatId: text("telegram_chat_id").primaryKey(),
  addedAtEpoch: integer("added_at_epoch").notNull(),
});

export const scheduledNotifications = pgTable(
  "scheduled_notifications",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    fireAtEpoch: integer("fire_at_epoch").notNull(),
    status: text("status").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    createdAtEpoch: integer("created_at_epoch").notNull(),
    updatedAtEpoch: integer("updated_at_epoch").notNull(),
  },
  (table) => ({
    statusFireIdx: index("idx_scheduled_notifications_status_fire").on(
      table.status,
      table.fireAtEpoch,
    ),
  }),
);
