import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Operator-editable settings, one row per namespace (`crawl`, …). The value is
 * JSONB because its shape is owned by the zod schema that reads it, not by the
 * table: a new rate-limit knob is a schema change, not a migration.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
