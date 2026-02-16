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

