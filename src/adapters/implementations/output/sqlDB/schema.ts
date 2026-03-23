/**
 * Drizzle schema for Postgres. Add table definitions here or in separate files
 * under this folder and re-export. Used by drizzle-kit for migrations.
 */
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  userName: text("user_name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  email: text("email").notNull(),
  dob: integer("dob").notNull(),
  role: text("role").notNull(),
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
  createdAtEpoch: integer("created_at_epoch").notNull(),
});

export const jarvisConfig = pgTable("jarvis_config", {
  id: text("id").primaryKey(),
  systemPrompt: text("system_prompt").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
