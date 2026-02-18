/**
 * Drizzle schema for Postgres. Add table definitions here or in separate files
 * under this folder and re-export. Used by drizzle-kit for migrations.
 */
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Example table: original notes (raw user data before chunking/vectorization).
 * Add more tables as needed; each table can map to its own repository port.
 */
export const originalNotes = pgTable("original_notes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  rawData: text("raw_data").notNull(),
  createdAtTimestamp: integer("created_at_timestamp").notNull(),
  updatedAtTimestamp: integer("updated_at_timestamp").notNull(),
});

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
  preferredCategories: text("preferred_categories").array().notNull().default([]),
  secondaryPersonalities: text("secondary_personalities")
    .array()
    .notNull()
    .default([]),
  createdAtEpoch: integer("created_at_epoch").notNull(),
  updatedAtEpoch: integer("updated_at_epoch").notNull(),
});
