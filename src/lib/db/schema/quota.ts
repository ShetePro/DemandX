import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per-source request counters, keyed by source name (`github`, `hn`, `ddg`, …)
 * rather than by `providers.id`: search engines and platform scrapers are not
 * provider rows, and their quotas expire at different cadences.
 *
 * One row exists per source/window/window_start. The guard only reads and
 * writes the window that contains "now", so a new window starts at zero
 * without a reset job and old windows stay behind as an audit trail.
 */
export const sourceUsage = pgTable(
  'source_usage',
  {
    source: text('source').notNull(),
    window: text('window').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    requests: integer('requests').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.window, t.windowStart] }),
    check('source_usage_window_check', sql`${t.window} in ('minute', 'day', 'week', 'month')`),
  ],
);
