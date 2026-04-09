import { boolean, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  email: text("email").notNull().unique(),
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

// Preserved for ERC-4337 wallet abstraction (Phase 3)
export const userProfiles = pgTable("user_profiles", {
  userId: uuid("user_id").primaryKey(),
  telegramChatId: text("telegram_chat_id"),
  smartAccountAddress: text("smart_account_address"),
  eoaAddress: text("eoa_address"),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
